/**
 * ============================================================================
 *  Election.ts — Simple, single-use election state.
 * ============================================================================
 *
 * SINGLE-USE DESIGN (thesis prototype):
 *
 * This module holds a single global election configuration in memory.
 * There is NO MongoDB persistence for the election config — when the
 * node restarts, the election is gone. This simplification is intentional:
 *
 *   - The thesis demo flow is: create election → cast votes → auto-tally
 *     → auto-wipe → repeat. There is never a need to recover a mid-flight
 *     election after a crash because the demo runs fresh each time.
 *
 *   - Removing ElectionModel / Mongoose persistence for the config makes
 *     the code dramatically simpler and easier to explain in the thesis.
 *
 *   - Votes are STILL persisted to MongoDB as sealed blocks. Only the
 *     election *configuration* is ephemeral. The blockchain (the immutable
 *     ledger) remains the durable source of truth for tally purposes.
 *
 * FIELDS:
 *
 *   isActive    — Is there a live election right now?
 *   candidates  — The list of valid candidate identifiers.
 *   whitelist   — Ethereum addresses allowed to vote (lowercase).
 *   endTime     — Unix-ms timestamp when the election closes.
 *   electionId  — A simple identifier used to tag votes on the chain.
 *
 * AUTO-WIPE (how it enables rapid thesis demos):
 *
 * When the endTime is reached, server.ts fires a timer that:
 *   1. Tallies votes from the immutable blockchain.
 *   2. Deletes ALL blocks from MongoDB (fresh slate for next demo).
 *   3. Clears the in-memory chain, mempool, and double-vote set.
 *   4. Sets isActive = false so the GUI shows "no election".
 * This lets the examiner see a full election lifecycle in ~60 seconds,
 * then immediately start another round without restarting containers.
 * ============================================================================
 */

/**
 * ElectionConfig — the shape of a simplified election configuration.
 *
 * Broadcast via P2P (ELECTION_CREATED) so every node in the network
 * holds the same config in memory.
 */
export interface ElectionConfig {
  electionId: string;
  candidates: string[];
  whitelist: string[];   // lowercase Ethereum addresses
  endTime: number;       // Unix-ms
  isActive: boolean;
}

/**
 * Election — in-memory singleton for the current election state.
 *
 * Instantiated once per node. The Gateway sets the config via POST
 * /election and broadcasts it to Validators. Each Validator receives
 * the ELECTION_CREATED P2P message and calls `activate()`.
 */
export class Election {
  /** The active election config, or null if no election is running. */
  private config: ElectionConfig | null = null;

  // ── Mutators ──────────────────────────────────────────────────────

  /**
   * Activate a new election on this node.
   *
   * Overwrites any previous election (single-use design).
   * Whitelist addresses are normalised to lowercase for consistent
   * comparison with ECDSA-recovered addresses.
   */
  public activate(data: {
    electionId: string;
    candidates: string[];
    whitelist: string[];
    endTime: number;
  }): void {
    this.config = {
      electionId: data.electionId,
      candidates: data.candidates,
      whitelist: data.whitelist.map((a) => a.toLowerCase()),
      endTime: data.endTime,
      isActive: true,
    };
  }

  /** Mark the current election as finished. */
  public deactivate(): void {
    if (this.config) {
      this.config.isActive = false;
    }
  }

  /** Completely clear election state (used by auto-wipe). */
  public reset(): void {
    this.config = null;
  }

  // ── Queries ───────────────────────────────────────────────────────

  /** Return the current config snapshot (or null). */
  public getConfig(): ElectionConfig | null {
    return this.config;
  }

  /** Is there an active, open election right now? */
  public get isActive(): boolean {
    return this.config !== null && this.config.isActive;
  }

  /**
   * Validate whether a vote is eligible under current election rules.
   *
   * Checks performed (in order, cheapest first):
   *   1. Is there an active election?
   *   2. Is the current time before endTime?
   *   3. Is the sender in the voter whitelist?
   *   4. Is the candidateId a valid candidate?
   */
  public isVoteValid(vote: {
    senderPublicKey: string;
    candidateId: string;
  }): { valid: boolean; reason?: string } {
    if (!this.config || !this.config.isActive) {
      return { valid: false, reason: "No active election." };
    }

    if (Date.now() > this.config.endTime) {
      return { valid: false, reason: "Election has ended." };
    }

    if (!this.config.whitelist.includes(vote.senderPublicKey.toLowerCase())) {
      return { valid: false, reason: "Address not in whitelist." };
    }

    if (!this.config.candidates.includes(vote.candidateId)) {
      return {
        valid: false,
        reason: `Invalid candidate "${vote.candidateId}". Valid: [${this.config.candidates.join(", ")}].`,
      };
    }

    return { valid: true };
  }
}
