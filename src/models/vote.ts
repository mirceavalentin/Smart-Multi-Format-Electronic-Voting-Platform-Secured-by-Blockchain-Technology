/**
 * Vote — the atomic transaction of the blockchain.
 *
 * Each vote is a digitally-signed message asserting that a voter
 * (identified solely by their public key) has cast a ballot for a
 * specific candidate within a specific election.
 *
 * Design decisions:
 *  - `senderPublicKey` is the only voter identifier stored on-chain,
 *    preserving pseudonymity while still enabling signature verification.
 *  - `signature` is produced client-side with the voter's private key
 *    over the deterministic payload (senderPublicKey + candidateId + electionId + timestamp).
 *  - `electionId` scopes votes to a particular election, enabling
 *    multi-election support on a single chain.
 */

export interface Vote {
  /** Hex-encoded public key of the voter (secp256k1 / Ed25519). */
  senderPublicKey: string;

  /** Unique identifier of the chosen candidate. */
  candidateId: string;

  /** Identifier of the election this vote belongs to. */
  electionId: string;

  /** ISO-8601 UTC timestamp of when the vote was cast. */
  timestamp: string;

  /**
   * Hex-encoded cryptographic signature over the canonical
   * vote payload, produced by the voter's private key.
   */
  signature: string;
}
