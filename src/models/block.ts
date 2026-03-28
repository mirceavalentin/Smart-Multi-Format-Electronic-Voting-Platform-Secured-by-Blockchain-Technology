import type { Vote } from "./vote.js";

/**
 * Block — an immutable, hash-linked container of votes.
 *
 * Design decisions:
 *  - `index` provides a sequential, human-readable block height.
 *  - `previousHash` creates the tamper-evident chain: altering any
 *    prior block invalidates every subsequent hash.
 *  - `hash` is the SHA-256 digest of the canonical block header
 *    (index + previousHash + timestamp + nonce + merkle root of transactions).
 *  - `nonce` supports a Proof-of-Authority or lightweight PoW scheme
 *    for block finality (the specific consensus algorithm is defined
 *    in the core layer, not in this data model).
 *  - `transactions` is typed as `Vote[]` because votes are the only
 *    transaction type in this domain-specific chain.
 */

export interface Block {
  /** Sequential position in the chain (0 = genesis). */
  index: number;

  /** ISO-8601 UTC timestamp of block creation. */
  timestamp: string;

  /** Ordered list of votes included in this block. */
  transactions: Vote[];

  /** SHA-256 hash of the preceding block (hex-encoded). */
  previousHash: string;

  /** SHA-256 hash of this block's header (hex-encoded). */
  hash: string;

  /**
   * Arbitrary nonce used during block creation.
   * Supports consensus mechanisms that require hash-target searching.
   */
  nonce: number;
}
