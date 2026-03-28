/**
 * ============================================================================
 *  network/transactionGossipService.ts — Mempool gossip handler.
 * ============================================================================
 *
 * This module isolates vote transaction ingestion logic from socket and
 * chain-sync responsibilities. It handles BROADCAST_TRANSACTION payloads and
 * updates the shared TransactionPool.
 * ============================================================================
 */

import type { Vote } from "../models/vote.js";
import { TransactionPool } from "../core/TransactionPool.js";

export class TransactionGossipService {
  private txPool: TransactionPool;
  private nodeName: string;

  constructor(txPool: TransactionPool, nodeName: string) {
    this.txPool = txPool;
    this.nodeName = nodeName;
  }

  /** Parse and enqueue a BROADCAST_TRANSACTION payload. */
  public handleBroadcastTransaction(data: string): void {
    let vote: Vote;
    try {
      vote = JSON.parse(data) as Vote;
    } catch {
      console.warn(`[${this.nodeName}] [P2P] Invalid transaction data received, ignoring.`);
      return;
    }

    this.txPool.addTransaction(vote);
    console.log(
      `[${this.nodeName}] [P2P] Received BROADCAST_TRANSACTION -> ` +
      `added vote to pool (pool size: ${this.txPool.size}).`,
    );
  }
}
