/**
 * ============================================================================
 *  Blockchain.ts — The chain manager: creation, extension, and validation.
 * ============================================================================
 *
 * CONCEPTUAL BACKGROUND (for academic defence):
 *
 * A "blockchain" is not just a list of blocks — it is a **protocol** that
 * defines how blocks are created, linked, and verified. This class
 * encapsulates the three fundamental operations of that protocol:
 *
 *   1. **Genesis** — bootstrapping the chain with a hard-coded first block.
 *   2. **Extension** — appending a new block that references the current tip.
 *   3. **Validation** — iterating the entire chain to confirm that every
 *      hash link is intact and every block's stored hash matches its
 *      recomputed hash.
 *
 * WHY A GENESIS BLOCK?
 *
 * Every block stores the hash of the block before it (`previousHash`).
 * The very first block has no predecessor, so we fabricate one with
 * well-known, deterministic values. All nodes in the network must agree
 * on the genesis block — if they don't, they are effectively on
 * different chains and will reject each other's blocks. The genesis
 * block therefore acts as the **root of trust** for the entire chain.
 *
 * WHY FULL-CHAIN VALIDATION?
 *
 * In a private / consortium blockchain (like our voting platform), new
 * peers joining the network receive a copy of the chain from an existing
 * peer. Before trusting that copy, the new peer must verify every link.
 * `isChainValid()` performs this check in O(n) time where n is chain
 * length. It guarantees two invariants:
 *
 *   A. **Hash integrity** — each block's `hash` field equals the hash
 *      recomputed from its contents (no data has been modified).
 *   B. **Link integrity** — each block's `previousHash` equals the
 *      `hash` of the block at the prior index (no blocks have been
 *      inserted, removed, or reordered).
 *
 * If either invariant is violated, the chain is considered corrupted or
 * tampered with and must be rejected.
 * ============================================================================
 */

import { Block } from "./Block.js";
import type { Vote } from "../models/vote.js";

export class Blockchain {
  /**
   * The ordered array of blocks comprising the chain.
   *
   * Index 0 is always the genesis block. The array is append-only
   * during normal operation; blocks are never removed or replaced
   * (immutability is a core blockchain guarantee).
   */
  public chain: Block[];

  /**
   * Initialise a new blockchain.
   *
   * If no existing chain is provided (e.g. loaded from MongoDB),
   * we bootstrap with a single genesis block so the chain is never
   * empty — every subsequent operation can safely assume `chain[0]`
   * exists.
   */
  constructor() {
    this.chain = [this.createGenesisBlock()];
  }

  // ────────────────────────────────────────────────────────────────────
  //  Genesis
  // ────────────────────────────────────────────────────────────────────

  /**
   * Create the genesis (first) block of the chain.
   *
   * Convention:
   *  - index        = 0          (it is the very first block)
   *  - timestamp    = fixed date (deterministic across all nodes)
   *  - transactions = []         (no votes in the genesis block)
   *  - previousHash = "0"        (there is no previous block)
   *  - nonce        = 0          (no mining required for genesis)
   *
   * The `hash` is computed automatically by the Block constructor
   * from these values. Because every field is deterministic, every
   * node that calls `createGenesisBlock()` will produce the exact
   * same hash — this is what allows nodes to recognise each other
   * as members of the same chain.
   *
   * @returns A new Block instance representing the genesis block.
   */
  private createGenesisBlock(): Block {
    return new Block(
      0,                          // index
      "2026-01-01T00:00:00.000Z", // timestamp — fixed epoch for this chain
      [],                         // transactions — no votes in genesis
      "0",                        // previousHash — sentinel value
      0,                          // nonce
    );
  }

  // ────────────────────────────────────────────────────────────────────
  //  Chain inspection
  // ────────────────────────────────────────────────────────────────────

  /**
   * Return the most recently appended block (the "chain tip").
   *
   * This is needed when creating a new block, because the new block's
   * `previousHash` must be set to the tip's `hash`.
   */
  public getLatestBlock(): Block {
    /*
     * Non-null assertion is safe here because the constructor always
     * seeds the chain with at least the genesis block, and blocks
     * are never removed.
     */
    return this.chain[this.chain.length - 1]!;
  }

  // ────────────────────────────────────────────────────────────────────
  //  Block creation
  // ────────────────────────────────────────────────────────────────────

  /**
   * Create and append a new block containing the given transactions.
   *
   * Steps:
   *  1. Read the latest block to obtain its hash (our `previousHash`).
   *  2. Determine the new block's index (latest index + 1).
   *  3. Stamp the current UTC time.
   *  4. Construct the Block — this automatically computes the hash.
   *  5. Append to the chain array.
   *
   * In a production system, step 4 would also involve a consensus
   * mechanism (e.g. Proof-of-Authority signature or Proof-of-Work
   * nonce search). For this prototype we create blocks immediately.
   *
   * @param transactions - The array of votes to include in the new block.
   * @returns The newly created and appended Block.
   */
  public addBlock(transactions: Vote[]): Block {
    const previousBlock: Block = this.getLatestBlock();

    const newBlock = new Block(
      previousBlock.index + 1,            // sequential index
      new Date().toISOString(),           // current UTC timestamp
      transactions,                       // the vote payload
      previousBlock.hash,                 // cryptographic back-link
      0,                                  // nonce (no PoW for now)
    );

    /*
     * At this point `newBlock.hash` already incorporates all five
     * fields including `previousBlock.hash`. If `previousBlock` were
     * ever tampered with, its hash would change, and this new block's
     * hash would no longer match what was originally computed — the
     * chain validation would catch the inconsistency.
     */
    this.chain.push(newBlock);

    return newBlock;
  }

  // ────────────────────────────────────────────────────────────────────
  //  Chain validation
  // ────────────────────────────────────────────────────────────────────

  /**
   * Validate the integrity of the entire blockchain.
   *
   * We iterate from block 1 (skipping genesis, which has no predecessor)
   * and check two invariants for every consecutive pair (previous, current):
   *
   *   **Invariant A — Hash integrity:**
   *   Recompute the current block's hash from its contents and compare
   *   it to the stored `hash` field. If they differ, the block's data
   *   has been modified after creation.
   *
   *   **Invariant B — Link integrity:**
   *   Verify that `currentBlock.previousHash === previousBlock.hash`.
   *   If they differ, either a block has been inserted/removed between
   *   them, or the previous block's data has been altered (changing its
   *   hash) without updating the link.
   *
   * Time complexity: O(n) where n = chain length.
   * Space complexity: O(1) — we only keep references to two blocks.
   *
   * @returns `true` if the chain is valid, `false` otherwise.
   */
  public isChainValid(): boolean {
    for (let i = 1; i < this.chain.length; i++) {
      const currentBlock: Block = this.chain[i]!;
      const previousBlock: Block = this.chain[i - 1]!;

      /*
       * Invariant A — Hash integrity check.
       *
       * We call `calculateHash()` which rebuilds the SHA-256 digest
       * from the block's current field values. If someone modified
       * any field (e.g. changed a vote's candidateId), the recomputed
       * hash will differ from the stored `hash`.
       */
      if (currentBlock.hash !== currentBlock.calculateHash()) {
        console.error(
          `[VALIDATION FAILED] Block ${currentBlock.index}: ` +
          `stored hash does not match recomputed hash. ` +
          `Data integrity compromised.`,
        );
        return false;
      }

      /*
       * Invariant B — Link integrity check.
       *
       * Each block's `previousHash` must point to the *actual* hash
       * of the preceding block. This is the "chain" in "blockchain".
       * Breaking this link means the ordering or content of prior
       * blocks has been altered.
       */
      if (currentBlock.previousHash !== previousBlock.hash) {
        console.error(
          `[VALIDATION FAILED] Block ${currentBlock.index}: ` +
          `previousHash does not match hash of block ${previousBlock.index}. ` +
          `Chain link broken.`,
        );
        return false;
      }
    }

    /*
     * If we reach here, every block's hash is self-consistent and
     * every link correctly references the prior block's hash.
     * The chain is cryptographically intact.
     */
    return true;
  }

  // ────────────────────────────────────────────────────────────────────
  //  Auto-wipe reset (thesis demo helper)
  // ────────────────────────────────────────────────────────────────────

  /**
   * Reset the in-memory chain back to a fresh genesis block.
   *
   * AUTO-WIPE CONTEXT:
   * After the tally timer fires, the demo flow wipes the blockchain so
   * the examiner can start a brand-new election without restarting
   * containers. This method handles the in-memory part — the caller
   * (server.ts) also does `BlockModel.deleteMany({})` for MongoDB.
   */
  public resetToGenesis(): void {
    this.chain = [this.createGenesisBlock()];
  }
}
