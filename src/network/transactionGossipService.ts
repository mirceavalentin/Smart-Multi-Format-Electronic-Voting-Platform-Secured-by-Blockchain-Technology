/**
 * transactionGossipService.ts — Mempool vote ingestion from the message bus.
 *
 * When a VOTE message arrives on a Validator's queue, the raw payload is a
 * JSON string. This service parses it and adds the vote to the local
 * TransactionPool so the next mining cycle can seal it into a block.
 *
 * Keeping this in its own class rather than inline in messageBus.ts
 * preserves the separation of concerns from the original design and makes
 * the parsing + pool-add logic independently unit-testable.
 */

import type { Vote }        from "../models/vote.js";
import { TransactionPool }  from "../core/TransactionPool.js";

export class TransactionGossipService {
  constructor(
    private readonly txPool:    TransactionPool,
    private readonly nodeName:  string,
  ) {}

  /**
   * Parse a raw JSON vote payload and add it to the mempool.
   *
   * @param data - JSON-serialised Vote object (msg.content.toString()).
   */
  public handleIncomingVote(data: string): void {
    let vote: Vote;
    try {
      vote = JSON.parse(data) as Vote;
    } catch {
      console.warn(`[${this.nodeName}] [Gossip] Invalid vote payload received — ignoring.`);
      return;
    }

    this.txPool.addTransaction(vote);
    console.log(
      `[${this.nodeName}] [Gossip] Vote added to mempool ` +
      `(candidate: ${vote.candidateId}, pool size: ${this.txPool.size}).`,
    );
  }
}
