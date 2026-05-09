/**
 * chainSyncService.ts — Blockchain sync and persistence logic.
 *
 * This module is responsible for deciding what to do when a new block
 * arrives from the message bus — append it, request a full chain, or
 * ignore it — and for keeping MongoDB in sync with whatever the node
 * decides is the authoritative chain.
 *
 * It is deliberately decoupled from the transport layer (RabbitMQ) via
 * two callbacks injected at construction time. This makes the class easy
 * to unit-test without a live broker: just pass mock callbacks.
 *
 * DECISION TREE (called on every incoming BLOCK message)
 * ───────────────────────────────────────────────────────
 *
 *   Received block index <= local tip index
 *     → stale, ignore.
 *
 *   Received block's previousHash === local tip's hash
 *     → fast path: append directly, persist to MongoDB, forward block.
 *
 *   Received block's index > local tip + 1 (gap)
 *     → slow path: request full chain from all peers, validate, replace.
 */

import type { Block as IBlock } from "../models/block.js";
import { Block }               from "../core/Block.js";
import { Blockchain }          from "../core/Blockchain.js";
import { TransactionPool }     from "../core/TransactionPool.js";
import { BlockModel }          from "../db/models.js";

export class ChainSyncService {
  /**
   * Called when this node appended or forwarded a block that peers
   * may not have yet. The callback should publish the block to the
   * message bus so all peers can update their chains.
   */
  private readonly onPublishBlock: (block: IBlock) => void;

  /**
   * Called when a received block cannot be appended directly (gap in
   * chain). The callback should broadcast a CHAIN_REQUEST to all peers
   * and return all the chains they send back.
   */
  private readonly onRequestFullChain: () => Promise<IBlock[][]>;

  constructor(
    private readonly blockchain: Blockchain,
    private readonly txPool:     TransactionPool,
    private readonly nodeName:   string,
    onPublishBlock:     (block: IBlock) => void,
    onRequestFullChain: () => Promise<IBlock[][]>,
  ) {
    this.onPublishBlock      = onPublishBlock;
    this.onRequestFullChain  = onRequestFullChain;
  }

  // ── Entry point ───────────────────────────────────────────────────

  /**
   * Process a block received from a peer via the message bus.
   *
   * The data parameter is a JSON string so the method signature is
   * consistent with how RabbitMQ message bodies arrive (as raw strings
   * after calling msg.content.toString()). This keeps the parsing
   * concern inside the service rather than in the caller.
   */
  public handleReceivedBlock(data: string): void {
    let receivedBlock: IBlock;
    try {
      receivedBlock = JSON.parse(data) as IBlock;
    } catch {
      console.warn(`[${this.nodeName}] [Sync] Invalid block data received — ignoring.`);
      return;
    }

    const latestLocal = this.blockchain.getLatestBlock();

    // Block is not newer than what we have — nothing to do.
    if (receivedBlock.index <= latestLocal.index) {
      console.log(
        `[${this.nodeName}] [Sync] Received block ${receivedBlock.index} ` +
        `<= local tip ${latestLocal.index} — stale, ignoring.`,
      );
      return;
    }

    // Fast path: received block extends our current tip directly.
    if (latestLocal.hash === receivedBlock.previousHash) {
      this.appendBlock(receivedBlock);
      return;
    }

    // Slow path: gap in chain — kick off async full-chain sync.
    console.log(
      `[${this.nodeName}] [Sync] Block ${receivedBlock.index} does not extend ` +
      `local tip (index ${latestLocal.index}) — requesting full chain from peers.`,
    );
    this.syncFullChain().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.nodeName}] [Sync] Full chain sync failed: ${msg}`);
    });
  }

  // ── Block append (fast path) ──────────────────────────────────────

  /**
   * Validate and append a single block to the local chain.
   *
   * We reconstruct the block via the Block constructor so calculateHash()
   * runs, then verify the stored hash matches. If it doesn't, the block
   * was tampered with in transit and we reject it.
   */
  private appendBlock(received: IBlock): void {
    const block = new Block(
      received.index,
      received.timestamp,
      received.transactions,
      received.previousHash,
      received.nonce,
    );

    if (block.hash !== received.hash) {
      console.warn(
        `[${this.nodeName}] [Sync] Hash mismatch on block ${received.index} — rejecting.`,
      );
      return;
    }

    this.blockchain.chain.push(block);
    console.log(`[${this.nodeName}] [Sync] Appended block ${block.index} (hash: ${block.hash.slice(0, 12)}…).`);

    // Remove votes that are now sealed in this block from our mempool
    // so the next Validator cycle doesn't try to include them again.
    const minedSigs = new Set(block.transactions.map((tx) => tx.signature));
    this.txPool.removeMinedTransactions(minedSigs);

    // Persist the new block to MongoDB.
    this.persistBlock(block).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.nodeName}] [Sync] Failed to persist block ${block.index}: ${msg}`);
    });

    // Tell peers about the block we just appended (they may not have it).
    this.onPublishBlock(block);
  }

  // ── Full chain sync (slow path) ───────────────────────────────────

  /**
   * Request the full chain from all peers, then replace the local chain
   * if any peer has a longer valid one.
   */
  private async syncFullChain(): Promise<void> {
    const allChains = await this.onRequestFullChain();

    if (allChains.length === 0) {
      console.warn(`[${this.nodeName}] [Sync] No chain responses received — keeping local chain.`);
      return;
    }

    // Pick the longest chain we received (we'll validate it before using it).
    const longest = allChains.reduce(
      (best, chain) => chain.length > best.length ? chain : best,
      allChains[0]!,
    );

    this.tryReplaceChain(longest);
  }

  /**
   * Validate a candidate chain and replace the local one if it is both
   * longer and cryptographically valid.
   */
  private tryReplaceChain(receivedBlocks: IBlock[]): void {
    // Reconstruct Block instances so we can call isChainValid().
    const candidate: Block[] = receivedBlocks.map(
      (b) => new Block(b.index, b.timestamp, b.transactions, b.previousHash, b.nonce),
    );

    // Verify that every stored hash matches the recomputed hash.
    for (let i = 0; i < candidate.length; i++) {
      if (candidate[i]!.hash !== receivedBlocks[i]!.hash) {
        console.warn(`[${this.nodeName}] [Sync] Hash mismatch at index ${i} — rejecting chain.`);
        return;
      }
    }

    // Verify hash-links and block ordering.
    const tempChain = new Blockchain();
    tempChain.chain = candidate;
    if (!tempChain.isChainValid()) {
      console.warn(`[${this.nodeName}] [Sync] Received chain failed validation — rejecting.`);
      return;
    }

    if (candidate.length <= this.blockchain.chain.length) {
      console.log(`[${this.nodeName}] [Sync] Received chain is not longer than local — keeping local.`);
      return;
    }

    console.log(
      `[${this.nodeName}] [Sync] Replacing chain: ` +
      `${this.blockchain.chain.length} → ${candidate.length} blocks.`,
    );

    this.blockchain.chain = candidate;

    // Remove all votes that appear in the new chain from the mempool.
    const allMinedSigs = new Set<string>(
      candidate.flatMap((b) => b.transactions.map((tx) => tx.signature)),
    );
    this.txPool.removeMinedTransactions(allMinedSigs);

    // Persist the entire new chain to MongoDB (replaces old blocks).
    this.persistFullChain(candidate).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.nodeName}] [Sync] Failed to persist replaced chain: ${msg}`);
    });

    // Inform peers of the new tip.
    this.onPublishBlock(this.blockchain.getLatestBlock());
  }

  // ── Persistence ───────────────────────────────────────────────────

  /** Upsert a single block into MongoDB. */
  private async persistBlock(block: Block): Promise<void> {
    await BlockModel.updateOne(
      { index: block.index },
      { $set: block.toJSON() },
      { upsert: true },
    );
    console.log(`[${this.nodeName}] [Sync] Block ${block.index} persisted to MongoDB.`);
  }

  /** Replace MongoDB's entire blocks collection with the new chain. */
  private async persistFullChain(chain: Block[]): Promise<void> {
    await BlockModel.deleteMany({});
    await BlockModel.insertMany(chain.map((b) => b.toJSON()));
    console.log(`[${this.nodeName}] [Sync] Full chain (${chain.length} blocks) persisted to MongoDB.`);
  }
}
