/**
 * ============================================================================
 *  TransactionPool.ts — The in-memory mempool for pending votes (transactions).
 * ============================================================================
 *
 * CONCEPTUAL BACKGROUND (for academic defence):
 *
 * In every blockchain architecture — whether public (Bitcoin, Ethereum) or
 * private (Hyperledger, our PoA voting chain) — there is a fundamental
 * separation between **submitting** a transaction and **committing** it
 * inside a block. The intermediary holding area is called the
 * **transaction pool** (or "mempool").
 *
 * WHY DO WE NEED A MEMPOOL?
 *
 * 1. **Decoupling producers from consumers.**
 *    Voters (producers) may submit votes at any time via the Gateway's
 *    HTTP API. Validators (consumers) create blocks on a fixed schedule.
 *    The mempool bridges this timing mismatch: votes accumulate in the
 *    pool until the next Validator cycle drains them into a block.
 *
 * 2. **Separation of concerns — Gateway vs Validator.**
 *    In our Proof-of-Authority (PoA) design, the Gateway node is a
 *    public-facing ingress point. It accepts votes and gossips them to
 *    the network, but it **never** creates blocks. Only Validator nodes
 *    — whose identities are pre-approved by the election authority —
 *    are permitted to seal blocks. This enforces the PoA trust model:
 *    block production is restricted to a known, accountable set of nodes.
 *
 * 3. **Consistency across the network.**
 *    When a vote arrives at the Gateway, it is broadcast via P2P to all
 *    peers (including Validators). Every node maintains its own local
 *    copy of the pool. When a Validator mines a block, it drains *its*
 *    pool and broadcasts the resulting block. Other nodes then remove
 *    those transactions from their own pools upon receiving the block
 *    (handled externally in the P2P layer).
 *
 * WHY NOT JUST PUT VOTES DIRECTLY INTO BLOCKS?
 *
 * If the Gateway created blocks immediately upon receiving a vote, it
 * would violate the PoA security model: an attacker who compromises
 * the Gateway could forge blocks. By deferring block creation to
 * Validators, we ensure that even if the Gateway is compromised, the
 * attacker can only inject *pending* transactions — the Validators
 * still control which transactions actually make it into the chain
 * (and can apply validation / deduplication logic before sealing).
 * ============================================================================
 */

import type { Vote } from "../models/vote.js";

export class TransactionPool {
  /**
   * The in-memory array of pending votes awaiting inclusion in a block.
   *
   * This is intentionally a simple array rather than a Map or Set because:
   *   - Vote deduplication (by signature) is a future concern; for now we
   *     trust the submission pipeline.
   *   - Order of insertion is preserved, which is desirable for fairness.
   *   - The pool is drained entirely on each Validator cycle, so it never
   *     grows unboundedly under normal load.
   */
  private pending: Vote[] = [];

  // ────────────────────────────────────────────────────────────────────
  //  Public API
  // ────────────────────────────────────────────────────────────────────

  /**
   * Add a single vote (transaction) to the pending pool.
   *
   * Called in two scenarios:
   *   1. The Gateway receives a vote via POST /vote and adds it locally.
   *   2. Any node receives a BROADCAST_TRANSACTION P2P message and adds
   *      the vote to its own pool so Validators have it available.
   *
   * @param vote - The vote to enqueue.
   */
  public addTransaction(vote: Vote): void {
    this.pending.push(vote);
  }

  /**
   * Return a **shallow copy** of all pending votes.
   *
   * We return a copy so that the caller (the Validator mining loop) can
   * iterate over it safely while `clearPool()` resets the original array.
   *
   * @returns An array of pending Vote objects.
   */
  public getTransactions(): Vote[] {
    return [...this.pending];
  }

  /**
   * Remove all votes from the pool.
   *
   * Called by the Validator immediately after it has sealed a new block
   * containing these transactions. This prevents the same votes from
   * being included in the next block.
   */
  public clearPool(): void {
    this.pending = [];
  }

  /**
   * Return the number of votes currently waiting in the pool.
   *
   * Useful for the Validator loop condition ("only mine if there are
   * pending votes") and for diagnostic HTTP endpoints.
   */
  public get size(): number {
    return this.pending.length;
  }
}
