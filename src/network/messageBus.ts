/**
 * messageBus.ts — RabbitMQ message bus (replaces the WebSocket P2P layer).
 *
 * WHY RABBITMQ?
 * ─────────────
 * The previous P2P layer required every node to maintain direct WebSocket
 * connections to every other node (full-mesh topology). This meant:
 *   - Each node managed its own socket pool and reconnection logic.
 *   - Chain sync required a custom request/response ping-pong protocol.
 *   - Auto-wipe timers were duplicated in both server.ts and p2p.ts.
 *
 * RabbitMQ replaces all of that with a dedicated message broker. Nodes
 * publish to named exchanges and subscribe from their own queues. The
 * broker handles routing, delivery guarantees, and fan-out — none of
 * which need to be hand-coded any more.
 *
 * TOPOLOGY
 * ────────
 *                     ┌──────────────────────────────┐
 *   Gateway ──────►   │   RabbitMQ cluster (3 nodes)  │   ◄────── Validators 1–3
 *                     └──────────────────────────────┘
 *
 * EXCHANGES (all fanout — every bound queue gets a copy of every message)
 * ──────────────────────────────────────────────────────────────────────
 *   voting.votes      Gateway publishes accepted votes → Validators' mempools
 *   voting.election   Gateway publishes election config → all nodes activate
 *   voting.blocks     Validators publish mined blocks  → all nodes sync chain
 *   voting.chain-req  Any node requests full chain     → all peers respond
 *
 * QUEUES (one per node per exchange)
 * ──────────────────────────────────
 *   votes.{nodeName}       receives vote messages
 *   election.{nodeName}    receives election config messages
 *   blocks.{nodeName}      receives new block messages
 *   chain-req.{nodeName}   receives chain sync requests from peers
 *   chain-res.{nodeName}   receives chain sync responses (exclusive, non-durable)
 *
 * CHAIN SYNC FLOW
 * ───────────────
 *   1. Validator A mines block 3, publishes BLOCK to voting.blocks.
 *   2. Validator B (still at block 1) receives the message from blocks.validator-b.
 *   3. Block 3 can't be appended (gap) → Validator B publishes CHAIN_REQUEST
 *      to voting.chain-req, embedding its reply queue "chain-res.validator-b".
 *   4. All nodes receive the request. Each responds by publishing its full chain
 *      directly to "chain-res.validator-b" (via the default exchange).
 *   5. requestFullChain() collects responses for CHAIN_SYNC_TIMEOUT_MS, then
 *      returns all received chains. The caller picks the longest valid one.
 */

import amqp, {
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
} from "amqplib";
import type { Block as IBlock }  from "../models/block.js";
import type { Vote }             from "../models/vote.js";
import type { ElectionConfig }   from "../core/Election.js";
import type {
  VoteMessage,
  ElectionMessage,
  BlockMessage,
  ChainRequestMessage,
  ChainResponseMessage,
} from "./messageTypes.js";

// ─── Exchange names ─────────────────────────────────────────────────
const EXCHANGE_VOTES     = "voting.votes";
const EXCHANGE_ELECTION  = "voting.election";
const EXCHANGE_BLOCKS    = "voting.blocks";
const EXCHANGE_CHAIN_REQ = "voting.chain-req";

// How long to wait for chain sync responses before giving up.
// 5 s is generous for a LAN/container environment.
const CHAIN_SYNC_TIMEOUT_MS = 5_000;

export class MessageBus {
  // amqplib names the object returned by connect() "ChannelModel" (confusingly).
  // It is the top-level connection handle that creates channels.
  private connection: ChannelModel | null = null;
  private channel:    Channel      | null = null;

  // Per-node queue names. Using the node name ensures every node in
  // the cluster has its own private copy of each message stream.
  private readonly queueVotes:    string;
  private readonly queueElection: string;
  private readonly queueBlocks:   string;
  private readonly queueChainReq: string;
  private readonly queueChainRes: string;

  constructor(private readonly nodeName: string) {
    this.queueVotes    = `votes.${nodeName}`;
    this.queueElection = `election.${nodeName}`;
    this.queueBlocks   = `blocks.${nodeName}`;
    this.queueChainReq = `chain-req.${nodeName}`;
    this.queueChainRes = `chain-res.${nodeName}`;
  }

  // ── Connection ────────────────────────────────────────────────────

  /**
   * Connect to RabbitMQ with exponential back-off retry.
   *
   * Like the MongoDB connection in db/connection.ts, this retries because
   * the broker container may still be initialising when the app starts.
   */
  async connect(url: string, maxRetries = 15, delayMs = 3_000): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.connection = await amqp.connect(url);
        this.channel    = await this.connection.createChannel();

        // Prefetch(1) means the broker won't send a second message until
        // the first has been ack'd. This prevents a slow consumer from
        // accumulating an unbounded backlog.
        await this.channel.prefetch(1);

        await this.declareInfrastructure();

        console.log(`[${this.nodeName}] [MQ] Connected to RabbitMQ.`);

        // Log connection-level errors so they appear in the container output.
        this.connection.on("error", (err: Error) => {
          console.error(`[${this.nodeName}] [MQ] Connection error: ${err.message}`);
        });
        this.connection.on("close", () => {
          console.warn(`[${this.nodeName}] [MQ] Connection closed.`);
        });

        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[${this.nodeName}] [MQ] Connection attempt ${attempt}/${maxRetries} failed: ${msg}. ` +
          `Retrying in ${delayMs / 1000}s...`,
        );
        if (attempt === maxRetries) throw err;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  /** Whether a channel is open and ready to use. */
  get isConnected(): boolean {
    return this.channel !== null;
  }

  /**
   * Declare all exchanges and per-node queues, then bind queues to exchanges.
   *
   * Idempotent — safe to call even if the exchanges/queues already exist
   * from a previous run (RabbitMQ ignores duplicate declares with the same
   * options).
   */
  private async declareInfrastructure(): Promise<void> {
    const ch = this.ch();

    // Fanout exchanges: every bound queue gets a copy of every message.
    // durable:true means they survive a broker restart.
    await ch.assertExchange(EXCHANGE_VOTES,     "fanout", { durable: true });
    await ch.assertExchange(EXCHANGE_ELECTION,  "fanout", { durable: true });
    await ch.assertExchange(EXCHANGE_BLOCKS,    "fanout", { durable: true });
    await ch.assertExchange(EXCHANGE_CHAIN_REQ, "fanout", { durable: true });

    // Durable per-node queues. They survive broker restarts so messages
    // published while a node was briefly offline are not lost.
    await ch.assertQueue(this.queueVotes,    { durable: true });
    await ch.assertQueue(this.queueElection, { durable: true });
    await ch.assertQueue(this.queueBlocks,   { durable: true });
    await ch.assertQueue(this.queueChainReq, { durable: true });

    // The chain-response queue is exclusive to this session and ephemeral.
    // Chain sync requests are transient — there is no point accumulating
    // stale chain responses from previous runs.
    await ch.assertQueue(this.queueChainRes, { durable: false, exclusive: true });

    // Bind queues to exchanges. Routing key is ignored for fanout.
    await ch.bindQueue(this.queueVotes,    EXCHANGE_VOTES,     "");
    await ch.bindQueue(this.queueElection, EXCHANGE_ELECTION,  "");
    await ch.bindQueue(this.queueBlocks,   EXCHANGE_BLOCKS,    "");
    await ch.bindQueue(this.queueChainReq, EXCHANGE_CHAIN_REQ, "");

    console.log(`[${this.nodeName}] [MQ] Exchanges and queues declared.`);
  }

  // ── Publishers ────────────────────────────────────────────────────

  /**
   * Publish a validated vote to all Validators' mempools.
   * Called by the Gateway after HTTP-layer signature verification.
   */
  publishVote(vote: Vote): void {
    const msg: VoteMessage = { type: "VOTE", fromNode: this.nodeName, vote };
    this.publish(EXCHANGE_VOTES, msg);
    console.log(`[${this.nodeName}] [MQ] ► VOTE published (candidate: ${vote.candidateId}).`);
  }

  /**
   * Broadcast a new election configuration to every node in the network.
   * Called by the Gateway when POST /api/election succeeds.
   */
  publishElection(config: ElectionConfig): void {
    const msg: ElectionMessage = { type: "ELECTION", fromNode: this.nodeName, config };
    this.publish(EXCHANGE_ELECTION, msg);
    console.log(`[${this.nodeName}] [MQ] ► ELECTION published ("${config.electionId}").`);
  }

  /**
   * Broadcast a freshly mined block to every node for chain synchronisation.
   * Called by a Validator after it seals a block and persists it to MongoDB.
   */
  publishBlock(block: IBlock): void {
    const msg: BlockMessage = { type: "BLOCK", fromNode: this.nodeName, block };
    this.publish(EXCHANGE_BLOCKS, msg);
    console.log(`[${this.nodeName}] [MQ] ► BLOCK published (index ${block.index}).`);
  }

  /**
   * Send this node's full chain directly to a peer that requested it.
   *
   * We publish to the default exchange ("") with the reply queue name as
   * the routing key — RabbitMQ's standard mechanism for point-to-point
   * delivery without needing a named exchange.
   */
  publishChainResponse(replyQueue: string, chain: IBlock[]): void {
    const msg: ChainResponseMessage = {
      type: "CHAIN_RESPONSE",
      fromNode: this.nodeName,
      chain,
    };
    this.publish("", msg, replyQueue);
    console.log(
      `[${this.nodeName}] [MQ] ► CHAIN_RESPONSE sent to "${replyQueue}" (${chain.length} blocks).`,
    );
  }

  /**
   * Ask all peers to send their full chain to this node's response queue.
   * Used internally by requestFullChain().
   */
  private publishChainRequest(): void {
    const msg: ChainRequestMessage = {
      type: "CHAIN_REQUEST",
      fromNode: this.nodeName,
      replyQueue: this.queueChainRes,
    };
    this.publish(EXCHANGE_CHAIN_REQ, msg);
    console.log(`[${this.nodeName}] [MQ] ► CHAIN_REQUEST published.`);
  }

  // ── Subscribers ───────────────────────────────────────────────────

  /**
   * Subscribe to incoming vote messages (for Validators to populate mempool).
   * Skips messages this node published itself to avoid double-adding.
   */
  async subscribeToVotes(handler: (vote: Vote) => void): Promise<void> {
    await this.consume(this.queueVotes, (raw) => {
      const msg = this.parse<VoteMessage>(raw);
      if (!msg || msg.fromNode === this.nodeName) return; // skip self
      handler(msg.vote);
    });
    console.log(`[${this.nodeName}] [MQ] ◄ Subscribed to votes.`);
  }

  /**
   * Subscribe to election configuration messages.
   * Skips the message on the node that created the election (already active).
   */
  async subscribeToElections(handler: (config: ElectionConfig) => void): Promise<void> {
    await this.consume(this.queueElection, (raw) => {
      const msg = this.parse<ElectionMessage>(raw);
      if (!msg || msg.fromNode === this.nodeName) return; // skip self
      handler(msg.config);
    });
    console.log(`[${this.nodeName}] [MQ] ◄ Subscribed to elections.`);
  }

  /**
   * Subscribe to new block announcements.
   * Skips blocks this node mined (it already appended them locally).
   */
  async subscribeToBlocks(
    handler: (block: IBlock, fromNode: string) => void,
  ): Promise<void> {
    await this.consume(this.queueBlocks, (raw) => {
      const msg = this.parse<BlockMessage>(raw);
      if (!msg || msg.fromNode === this.nodeName) return; // skip self
      handler(msg.block, msg.fromNode);
    });
    console.log(`[${this.nodeName}] [MQ] ◄ Subscribed to blocks.`);
  }

  /**
   * Subscribe to chain sync requests from other nodes.
   * When a peer can't append a received block, it asks everyone for the
   * full chain. We respond by sending our chain to their reply queue.
   */
  async subscribeToChainRequests(
    handler: (replyQueue: string) => void,
  ): Promise<void> {
    await this.consume(this.queueChainReq, (raw) => {
      const msg = this.parse<ChainRequestMessage>(raw);
      // Only respond to requests from OTHER nodes — not our own broadcast.
      if (!msg || msg.fromNode === this.nodeName) return;
      handler(msg.replyQueue);
    });
    console.log(`[${this.nodeName}] [MQ] ◄ Subscribed to chain requests.`);
  }

  // ── Chain sync ────────────────────────────────────────────────────

  /**
   * Broadcast a chain request to all peers and collect their responses.
   *
   * Returns an array of all chains received within CHAIN_SYNC_TIMEOUT_MS.
   * The caller (ChainSyncService) is responsible for picking the longest
   * valid chain from the results.
   *
   * WHY NOT JUST RESPOND TO THE FIRST CHAIN?
   * In a cluster with 3 Validators, all three may respond. We collect all
   * responses within the window and let the caller pick the best one.
   * This is more robust: if the fastest-responding node has a shorter
   * chain than the second responder, we still pick the longer one.
   */
  async requestFullChain(): Promise<IBlock[][]> {
    const ch = this.ch();
    const chains: IBlock[][] = [];

    // Set up a temporary consumer on our private response queue.
    // We cancel it after the timeout to stop collecting.
    const { consumerTag } = await ch.consume(
      this.queueChainRes,
      (raw) => {
        if (!raw) return;
        ch.ack(raw);
        const msg = this.parse<ChainResponseMessage>(raw);
        if (msg) {
          console.log(
            `[${this.nodeName}] [MQ] ◄ CHAIN_RESPONSE from ${msg.fromNode} ` +
            `(${msg.chain.length} blocks).`,
          );
          chains.push(msg.chain);
        }
      },
      { noAck: false },
    );

    // Broadcast the request AFTER setting up the consumer so we don't
    // miss any responses that arrive before consume() is registered.
    this.publishChainRequest();

    // Wait for responses, then stop collecting.
    await new Promise<void>((r) => setTimeout(r, CHAIN_SYNC_TIMEOUT_MS));
    await ch.cancel(consumerTag);

    console.log(
      `[${this.nodeName}] [MQ] Chain sync complete — received ${chains.length} response(s).`,
    );
    return chains;
  }

  // ── Private helpers ───────────────────────────────────────────────

  /**
   * Publish a JSON-serialisable object to an exchange.
   *
   * For point-to-point delivery (chain responses), pass exchange="" and
   * routingKey=queueName — RabbitMQ's default exchange routes by queue name.
   */
  private publish(exchange: string, message: object, routingKey = ""): void {
    const ch = this.ch();
    const body = Buffer.from(JSON.stringify(message));
    // persistent:true means messages survive a broker restart
    ch.publish(exchange, routingKey, body, { persistent: true });
  }

  /**
   * Register a consumer on a queue. Each message is ack'd after the
   * handler returns (or throws — we ack anyway to avoid infinite requeue).
   */
  private async consume(
    queue: string,
    handler: (msg: ConsumeMessage) => void,
  ): Promise<void> {
    const ch = this.ch();
    await ch.consume(
      queue,
      (raw) => {
        if (!raw) return;
        try {
          handler(raw);
        } finally {
          ch.ack(raw);
        }
      },
      { noAck: false },
    );
  }

  /** Attempt to parse a message body as JSON. Returns null on failure. */
  private parse<T>(msg: ConsumeMessage): T | null {
    try {
      return JSON.parse(msg.content.toString()) as T;
    } catch {
      console.warn(`[${this.nodeName}] [MQ] Failed to parse message body — discarding.`);
      return null;
    }
  }

  /** Assert the channel is open. Throws if connect() was not called first. */
  private ch(): Channel {
    if (!this.channel) {
      throw new Error("[MessageBus] Not connected — call connect() before publishing or subscribing.");
    }
    return this.channel;
  }
}
