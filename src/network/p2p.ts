/**
 * ============================================================================
 *  network/p2p.ts — Peer-to-Peer WebSocket layer for blockchain gossip.
 * ============================================================================
 *
 * CONCEPTUAL BACKGROUND (for academic defence):
 *
 * In a distributed blockchain network, every node must eventually hold
 * the same chain. There is **no central server** — nodes synchronise by
 * gossiping blocks to one another over direct WebSocket connections.
 *
 * Our gossip protocol works as follows:
 *
 *   1. On startup, each node opens a WebSocket **server** so peers can
 *      connect to it, and also acts as a **client** to dial its known
 *      seed peers.
 *
 *   2. When a new peer connection opens, the node immediately asks
 *      "What is your latest block?" (QUERY_LATEST). This lets the node
 *      quickly detect if it is behind.
 *
 *   3. When a node mines a new block, it broadcasts the block to ALL
 *      connected peers via RESPONSE_BLOCKCHAIN.
 *
 *   4. When a peer receives a pending vote (BROADCAST_TRANSACTION), it
 *      adds the vote to its local TransactionPool. This ensures every
 *      Validator has the pending votes available for its next mining cycle.
 *
 *   5. When a peer receives a new block:
 *      a. If the block extends the local chain by exactly 1, it is
 *         appended directly (fast path).
 *      b. If the received chain is longer, the node requests the full
 *         chain (QUERY_ALL), validates it, and if valid, replaces its
 *         local chain (longest-valid-chain rule).
 *      c. Otherwise the received data is stale and is ignored.
 *
 * This simple protocol guarantees **eventual consistency**: after a
 * propagation delay, all honest nodes converge on the same chain.
 * ============================================================================
 */

import WebSocket, { WebSocketServer } from "ws";
import { Blockchain } from "../core/Blockchain.js";
import { TransactionPool } from "../core/TransactionPool.js";
import { Election } from "../core/Election.js";
import type { ElectionConfig } from "../core/Election.js";
import { ChainSyncService } from "./chainSyncService.js";
import { TransactionGossipService } from "./transactionGossipService.js";
import {
  MessageType,
  queryLatestMsg,
  responseBlockchainMsg,
  type P2PMessage,
} from "./messageTypes.js";

export class P2PNetwork {
  /** All currently open WebSocket connections (both inbound and outbound). */
  private sockets: WebSocket[] = [];

  /** Reference to the shared in-memory blockchain instance. */
  private blockchain: Blockchain;

  /**
   * Reference to the shared TransactionPool (mempool).
   *
   * When a BROADCAST_TRANSACTION message arrives, the vote is added to
   * this pool. Validators drain the pool on their mining cycle.
   */
  private txPool: TransactionPool;

  /**
   * Reference to the shared Election state.
   *
   * When an ELECTION_CREATED message arrives from a peer, the P2P layer
   * activates the election on this node so every node in the network
   * enforces identical election rules (whitelist, candidates, time window).
   */
  private election: Election;

  /** Human-readable node name for log prefixes. */
  private nodeName: string;

  /** Delegated chain sync + persistence module. */
  private chainSyncService: ChainSyncService;

  /** Delegated mempool transaction gossip module. */
  private transactionGossipService: TransactionGossipService;

  constructor(blockchain: Blockchain, txPool: TransactionPool, election: Election, nodeName: string = "node") {
    this.blockchain = blockchain;
    this.txPool = txPool;
    this.election = election;
    this.nodeName = nodeName;

    this.chainSyncService = new ChainSyncService(
      this.blockchain,
      this.nodeName,
      (message: P2PMessage) => this.broadcast(message),
    );
    this.transactionGossipService = new TransactionGossipService(this.txPool, this.nodeName);
  }

  // ────────────────────────────────────────────────────────────────────
  //  Server — accept inbound peer connections
  // ────────────────────────────────────────────────────────────────────

  /**
   * Start a WebSocket server on the given port.
   *
   * Other nodes in the network will connect to this server to exchange
   * blocks. Each inbound connection is initialised the same way as an
   * outbound one — we register the message handler and immediately ask
   * the peer for its latest block.
   */
  public startServer(port: number): void {
    const server = new WebSocketServer({ port });

    server.on("connection", (ws: WebSocket, req) => {
      const remoteAddr = req.socket.remoteAddress ?? "unknown";
      console.log(`[${this.nodeName}] [P2P] ← Inbound peer connected from ${remoteAddr}`);
      this.initConnection(ws);
    });

    console.log(`[${this.nodeName}] [P2P] WebSocket server listening on port ${port}`);
  }

  // ────────────────────────────────────────────────────────────────────
  //  Client — dial outbound peers
  // ────────────────────────────────────────────────────────────────────

  /**
   * Connect to a list of seed peers.
   *
   * Each peer address is a WebSocket URL like "ws://validator1-app:6000".
   * If a connection fails, we log the error and move on — the peer may
   * not be up yet, and we'll synchronise when it connects to us later.
   */
  public connectToPeers(peerAddrs: string[]): void {
    for (const addr of peerAddrs) {
      const trimmed = addr.trim();
      if (!trimmed) continue;

      console.log(`[${this.nodeName}] [P2P] → Dialling peer ${trimmed}...`);

      const ws = new WebSocket(trimmed);

      ws.on("open", () => {
        console.log(`[${this.nodeName}] [P2P] → Connected to peer ${trimmed}`);
        this.initConnection(ws);
      });

      ws.on("error", (err) => {
        console.warn(
          `[${this.nodeName}] [P2P] ✘ Failed to connect to ${trimmed}: ${err.message}`,
        );
      });
    }
  }

  // ────────────────────────────────────────────────────────────────────
  //  Connection lifecycle
  // ────────────────────────────────────────────────────────────────────

  /**
   * Initialise a newly opened WebSocket connection (inbound or outbound).
   *
   * Steps:
   *   1. Add to the sockets pool.
   *   2. Register the message handler.
   *   3. Register cleanup on close/error.
   *   4. Ask the peer for its latest block to kick off sync.
   */
  private initConnection(ws: WebSocket): void {
    this.sockets.push(ws);

    ws.on("message", (raw: WebSocket.RawData) => {
      this.handleMessage(ws, raw);
    });

    ws.on("close", () => {
      this.sockets = this.sockets.filter((s) => s !== ws);
      console.log(`[${this.nodeName}] [P2P] Peer disconnected. Active peers: ${this.sockets.length}`);
    });

    ws.on("error", () => {
      this.sockets = this.sockets.filter((s) => s !== ws);
    });

    // Ask the peer for its latest block immediately.
    this.send(ws, queryLatestMsg());
  }

  // ────────────────────────────────────────────────────────────────────
  //  Message handling
  // ────────────────────────────────────────────────────────────────────

  /**
   * Parse and route an incoming P2P message.
   */
  private handleMessage(ws: WebSocket, raw: WebSocket.RawData): void {
    let message: P2PMessage;
    try {
      message = JSON.parse(raw.toString()) as P2PMessage;
    } catch {
      console.warn(`[${this.nodeName}] [P2P] Received unparseable message, ignoring.`);
      return;
    }

    switch (message.type) {
      case MessageType.QUERY_LATEST:
        /*
         * The peer wants our latest block. Respond with a single-element
         * array containing the chain tip.
         */
        console.log(`[${this.nodeName}] [P2P] Received QUERY_LATEST → sending latest block`);
        this.send(ws, responseBlockchainMsg([this.blockchain.getLatestBlock()]));
        break;

      case MessageType.QUERY_ALL:
        /*
         * The peer wants our entire chain. Respond with the full array.
         */
        console.log(`[${this.nodeName}] [P2P] Received QUERY_ALL → sending full chain (${this.blockchain.chain.length} blocks)`);
        this.send(ws, responseBlockchainMsg(this.blockchain.chain));
        break;

      case MessageType.RESPONSE_BLOCKCHAIN:
        /*
         * The peer is sending us blockchain data. Parse and process.
         */
        this.chainSyncService.handleBlockchainResponse(message.data);
        break;

      case MessageType.BROADCAST_TRANSACTION:
        /*
         * The peer is gossiping a pending vote (transaction).
         *
         * In the PoA architecture, votes enter the network at the Gateway
         * and are propagated to all nodes via this message type. Every
         * node — Gateway and Validators alike — adds the vote to its
         * local TransactionPool. When a Validator's mining cycle fires,
         * it drains its pool into a new block.
         *
         * NOTE: We do NOT re-broadcast the transaction here. The Gateway
         * already broadcasts to all peers, so re-broadcasting would cause
         * exponential message amplification (a "broadcast storm"). In a
         * larger network with partial connectivity, a gossip TTL or
         * seen-message cache would be needed, but for our 4-node full-mesh
         * topology, single-hop broadcast is sufficient.
         */
        this.transactionGossipService.handleBroadcastTransaction(message.data);
        break;

      case MessageType.ELECTION_CREATED:
        /*
         * A peer (the Gateway) is broadcasting a new election config.
         *
         * When the Administrator creates an election via POST /election,
         * the Gateway broadcasts it to all peers. Each receiving node:
         *   1. Parses the election configuration from the message.
         *   2. Calls ElectionManager.initializeElection() to persist it
         *      to MongoDB and activate it in memory.
         *   3. The ElectionManager also schedules the tally timer.
         *
         * This ensures that ALL nodes in the network — Gateway and
         * Validators alike — enforce identical election rules. Without
         * this propagation, a Validator might accept votes for candidates
         * or voters that were not defined in the election config.
         */
        this.handleElectionCreated(message.data);
        break;

      default:
        console.warn(`[${this.nodeName}] [P2P] Unknown message type: ${String((message as P2PMessage).type)}`);
    }
  }

  // ────────────────────────────────────────────────────────────────────
  //  Send / Broadcast
  // ────────────────────────────────────────────────────────────────────

  /** Send a message to a single peer. */
  private send(ws: WebSocket, message: P2PMessage): void {
    ws.send(JSON.stringify(message));
  }

  /**
   * Broadcast a message to ALL connected peers.
   *
   * Used after mining a new block to propagate it across the network.
   */
  public broadcast(message: P2PMessage): void {
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        this.send(socket, message);
      }
    }
    console.log(
      `[${this.nodeName}] [P2P] Broadcast type=${MessageType[message.type]} to ${this.sockets.filter((s) => s.readyState === WebSocket.OPEN).length} peers.`,
    );
  }

  /** Return the count of currently connected peers. */
  public getPeerCount(): number {
    return this.sockets.filter((s) => s.readyState === WebSocket.OPEN).length;
  }

  // ────────────────────────────────────────────────────────────────────
  //  Election gossip handler
  // ────────────────────────────────────────────────────────────────────

  /**
   * Handle an incoming ELECTION_CREATED message from a peer.
   *
   * Parses the election configuration and activates it on this node.
   * If the payload is malformed, we log a warning and discard it.
   */
  private handleElectionCreated(data: string): void {
    let config: ElectionConfig;
    try {
      config = JSON.parse(data) as ElectionConfig;
    } catch {
      console.warn(`[${this.nodeName}] [P2P] Invalid ELECTION_CREATED data, ignoring.`);
      return;
    }

    console.log(
      `[${this.nodeName}] [P2P] Received ELECTION_CREATED for "${config.electionId}". Activating...`,
    );

    this.election.activate(config);
  }
}
