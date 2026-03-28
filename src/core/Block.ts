/**
 * ============================================================================
 *  Block.ts — The fundamental unit of a blockchain.
 * ============================================================================
 *
 * CONCEPTUAL BACKGROUND (for academic defence):
 *
 * A blockchain is, at its core, a singly-linked list where each node
 * (block) contains a cryptographic digest (hash) of the previous node.
 * This creates a **tamper-evident** data structure: if any historical
 * block is modified — even by a single bit — its hash changes, which
 * invalidates the `previousHash` pointer stored in the *next* block,
 * which in turn invalidates *that* block's hash, and so on, cascading
 * all the way to the chain tip. An attacker would therefore need to
 * recompute every subsequent hash to forge the chain, which is the
 * security guarantee that makes blockchains useful for trustless systems.
 *
 * WHY SHA-256?
 *
 * SHA-256 (Secure Hash Algorithm, 256-bit) is a member of the SHA-2
 * family designed by the NSA and published by NIST. It is:
 *   1. **Deterministic** — the same input always yields the same output.
 *   2. **Pre-image resistant** — given a hash h, it is computationally
 *      infeasible to find any message m such that SHA-256(m) = h.
 *   3. **Second pre-image resistant** — given a message m₁, it is
 *      infeasible to find a different m₂ with the same hash.
 *   4. **Collision resistant** — it is infeasible to find any pair
 *      (m₁, m₂) where m₁ ≠ m₂ but SHA-256(m₁) = SHA-256(m₂).
 *
 * These properties make it ideal for block hashing: any mutation to
 * block data produces an entirely different 256-bit digest, making
 * tampering immediately detectable.
 *
 * We use Node.js's built-in `crypto` module which delegates to OpenSSL,
 * avoiding third-party dependencies for core cryptographic primitives.
 * ============================================================================
 */

import { createHash } from "node:crypto";
import type { Block as IBlock } from "../models/block.js";
import type { Vote } from "../models/vote.js";

/**
 * Concrete implementation of the {@link IBlock} interface.
 *
 * Instances are created via the constructor and are structurally
 * compatible with the interface so they can be serialised, stored
 * in MongoDB, or transmitted over the P2P network without conversion.
 */
export class Block implements IBlock {
  /** Sequential position in the chain (0 = genesis). */
  public readonly index: number;

  /** ISO-8601 UTC timestamp of block creation. */
  public readonly timestamp: string;

  /** Ordered list of vote transactions included in this block. */
  public readonly transactions: Vote[];

  /** SHA-256 hex digest of the preceding block. */
  public readonly previousHash: string;

  /** SHA-256 hex digest of *this* block's canonical header. */
  public readonly hash: string;

  /**
   * Nonce used during block creation.
   *
   * In a Proof-of-Work scheme the miner increments the nonce until the
   * resulting hash satisfies a difficulty target (e.g. starts with N
   * leading zeros). In our Proof-of-Authority model the nonce may be
   * fixed at 0 — but we keep the field so the data model remains
   * compatible with either consensus strategy.
   */
  public readonly nonce: number;

  /**
   * Construct a new block.
   *
   * @param index        - The block height (0 for genesis).
   * @param timestamp    - ISO-8601 creation time.
   * @param transactions - Array of vote transactions to seal in this block.
   * @param previousHash - Hash of the block immediately before this one.
   * @param nonce        - Nonce value (defaults to 0).
   *
   * The `hash` property is computed automatically from the other fields
   * at construction time, guaranteeing internal consistency.
   */
  constructor(
    index: number,
    timestamp: string,
    transactions: Vote[],
    previousHash: string,
    nonce: number = 0,
  ) {
    this.index = index;
    this.timestamp = timestamp;
    this.transactions = transactions;
    this.previousHash = previousHash;
    this.nonce = nonce;

    /*
     * The hash MUST be the very last assignment because it depends on
     * every other field. This ordering is critical — if you computed
     * the hash before assigning `nonce`, for example, the digest would
     * be based on incomplete data and later verification would fail.
     */
    this.hash = this.calculateHash();
  }

  // ────────────────────────────────────────────────────────────────────
  //  Hashing
  // ────────────────────────────────────────────────────────────────────

  /**
   * Compute the SHA-256 digest of this block's **canonical header**.
   *
   * The "canonical header" is a deterministic string representation of
   * every field that defines the block's identity. We concatenate them
   * in a fixed order and feed the result into SHA-256.
   *
   * **Why JSON.stringify for transactions?**
   * We need a deterministic string representation of the transactions
   * array. `JSON.stringify` is deterministic for the same input object
   * structure (same key order, same values). In production you would
   * typically compute a Merkle root of the transactions and include
   * only that root in the header — but for our thesis prototype a
   * direct serialisation is simpler and equally tamper-evident.
   *
   * **Why hex encoding?**
   * The raw SHA-256 output is 32 bytes of binary data. Hex encoding
   * doubles the length to 64 characters but makes the hash safely
   * printable, loggable, and embeddable in JSON without escaping.
   *
   * @returns The 64-character lowercase hex-encoded SHA-256 digest.
   */
  public calculateHash(): string {
    /*
     * Build the pre-image string in a fixed, documented order.
     * Any change to the order would produce a different hash, so this
     * ordering is part of the protocol specification.
     *
     * Field order: index → previousHash → timestamp → nonce → transactions
     */
    const preImage: string =
      this.index.toString() +
      this.previousHash +
      this.timestamp +
      this.nonce.toString() +
      JSON.stringify(this.transactions);

    /*
     * node:crypto.createHash creates a Hash stream.
     *  - .update(data) feeds data into the hash function.
     *  - .digest("hex") finalises the hash and returns the hex string.
     *
     * Internally this calls OpenSSL's EVP_DigestUpdate / EVP_DigestFinal,
     * which are heavily optimised (SIMD / hardware SHA instructions on
     * modern CPUs).
     */
    return createHash("sha256").update(preImage).digest("hex");
  }

  // ────────────────────────────────────────────────────────────────────
  //  Serialisation helper
  // ────────────────────────────────────────────────────────────────────

  /**
   * Return a plain object representation suitable for JSON serialisation
   * or MongoDB storage.
   */
  public toJSON(): IBlock {
    return {
      index: this.index,
      timestamp: this.timestamp,
      transactions: this.transactions,
      previousHash: this.previousHash,
      hash: this.hash,
      nonce: this.nonce,
    };
  }
}
