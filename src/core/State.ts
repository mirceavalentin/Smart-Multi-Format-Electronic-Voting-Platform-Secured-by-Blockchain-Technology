/**
 * ============================================================================
 *  State.ts — Global election state: double-vote prevention.
 * ============================================================================
 *
 * CONCEPTUAL BACKGROUND (for academic defence):
 *
 * A blockchain records history — it tells you *what happened*. But many
 * validation rules depend on *current state* ("has this voter already
 * cast a ballot?"). Deriving state by replaying the entire chain on
 * every request is O(n) — far too expensive at the Gateway's ingress
 * rate. Instead, we maintain a lightweight **in-memory state object**
 * that is updated incrementally as votes are accepted.
 *
 * WHY A SET?
 *
 * The core invariant of any election is **one person, one vote**. We
 * enforce this with a Set<string> keyed by the voter's Ethereum address
 * (recovered from the ECDSA signature — see server.ts). A Set provides
 * O(1) membership testing, which is critical because this check runs on
 * every incoming vote at the Gateway.
 *
 * WHY IN-MEMORY (NOT IN MONGODB)?
 *
 * For the thesis prototype, the voter set fits comfortably in RAM (even
 * 1 million 42-character Ethereum addresses ≈ 42 MB). Persisting to
 * MongoDB would add latency on the hot path. In a production system,
 * the state could be rebuilt from the chain on startup ("state replay")
 * and optionally checkpointed to disk for faster recovery.
 *
 * LIMITATION — GATEWAY-ONLY ENFORCEMENT:
 *
 * Because State is local to each process, double-vote prevention is
 * currently enforced only at the Gateway (the HTTP ingress point).
 * Validators trust that the Gateway has already filtered duplicates.
 * In a production multi-Gateway deployment, shared state (e.g. Redis)
 * or consensus-level deduplication would be required.
 * ============================================================================
 */

export class State {
  /**
   * Set of Ethereum addresses (checksummed or lowercase) that have
   * already cast a vote in the current election.
   *
   * Keyed by address rather than public key because `ethers.verifyMessage`
   * recovers an *address* (the last 20 bytes of keccak256(publicKey)),
   * which is the standard Ethereum identifier.
   */
  private votedAddresses: Set<string> = new Set();

  // ────────────────────────────────────────────────────────────────────
  //  Public API
  // ────────────────────────────────────────────────────────────────────

  /**
   * Check whether a given address has already voted.
   *
   * We normalise to lowercase before lookup so that checksummed and
   * non-checksummed addresses are treated identically.
   *
   * @param address - The Ethereum address to check.
   * @returns `true` if the address has already voted, `false` otherwise.
   */
  public hasVoted(address: string): boolean {
    return this.votedAddresses.has(address.toLowerCase());
  }

  /**
   * Record that an address has voted.
   *
   * Once marked, any future vote from this address will be rejected
   * by the `hasVoted` check in the POST /vote handler.
   *
   * @param address - The Ethereum address to mark as voted.
   */
  public markVoted(address: string): void {
    this.votedAddresses.add(address.toLowerCase());
  }

  /**
   * Return the total number of unique voters recorded so far.
   *
   * Useful for diagnostic endpoints (e.g. GET / health-check) and
   * for the thesis demo dashboard.
   */
  public get voterCount(): number {
    return this.votedAddresses.size;
  }

  /**
   * Clear ALL tracked voters (used by the auto-wipe reset between demos).
   *
   * After an election's tally completes, the auto-wipe process erases
   * the entire blockchain from MongoDB and resets in-memory state so a
   * fresh election can begin immediately. Without clearing this set,
   * voters who participated in the previous round would be permanently
   * blocked from voting again — which would break any subsequent demo.
   */
  public clear(): void {
    this.votedAddresses.clear();
  }
}
