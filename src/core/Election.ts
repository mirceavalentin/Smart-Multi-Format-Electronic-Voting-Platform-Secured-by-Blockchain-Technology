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
 * ElectionType — the format of the ballot.
 *
 *   single-choice    Voter selects exactly one candidate from the list.
 *                    The classic "first past the post" / plurality election.
 *
 *   multiple-choice  Voter selects 1..maxSelections candidates from the list
 *                    (approval voting). Each selected candidate gets one
 *                    point at tally time; the candidate(s) with the most
 *                    points win(s).
 *
 *   yes-no           Voter answers a single referendum question with "yes"
 *                    or "no". The `candidates` list is fixed to ["yes","no"]
 *                    and the human-readable question lives in `question`.
 */
export type ElectionType = "single-choice" | "multiple-choice" | "yes-no";

/**
 * Separator used to encode multi-choice selections inside Vote.candidateId.
 *
 * For multiple-choice ballots the voter picks several candidates, but we
 * keep the existing single-string `candidateId` field on Vote so the chain
 * data model and ECDSA signature payload stay unchanged. The selected
 * candidate names are simply joined with this separator, e.g. "Alice|Bob".
 *
 * The pipe character was chosen because:
 *   - It is not legal in any reasonable candidate name.
 *   - It does not need JSON-escaping, keeping the canonical signature
 *     payload identical across single/multi/yes-no formats.
 */
export const MULTI_CHOICE_SEPARATOR = "|" as const;

/**
 * ElectionConfig — the shape of an election configuration.
 *
 * Broadcast via the `voting.election` RabbitMQ exchange so every node in
 * the network holds the same config in memory.
 */
export interface ElectionConfig {
  electionId: string;
  type: ElectionType;
  candidates: string[];
  whitelist: string[];     // lowercase Ethereum addresses
  endTime: number;         // Unix-ms
  isActive: boolean;

  /** Referendum question shown to the voter (yes-no ballots only). */
  question?: string;

  /** Maximum candidates a voter may pick (multiple-choice ballots only). */
  maxSelections?: number;
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
   *
   * Per-format normalisation:
   *   - single-choice / multiple-choice: candidate list is taken as-is.
   *   - yes-no: candidate list is forced to ["yes","no"] regardless of
   *             what the caller supplied; the human question (if any)
   *             is stored separately in `question`.
   *   - multiple-choice: maxSelections defaults to candidates.length when
   *             omitted (i.e. voter may approve any subset).
   */
  public activate(data: {
    electionId: string;
    type?: ElectionType;
    candidates: string[];
    whitelist: string[];
    endTime: number;
    question?: string;
    maxSelections?: number;
  }): void {
    const type: ElectionType = data.type ?? "single-choice";

    const candidates =
      type === "yes-no" ? ["yes", "no"] : data.candidates;

    const maxSelections =
      type === "multiple-choice"
        ? Math.max(1, Math.min(data.maxSelections ?? candidates.length, candidates.length))
        : undefined;

    this.config = {
      electionId: data.electionId,
      type,
      candidates,
      whitelist: data.whitelist.map((a) => a.toLowerCase()),
      endTime: data.endTime,
      isActive: true,
      ...(type === "yes-no"          && data.question     ? { question: data.question }       : {}),
      ...(type === "multiple-choice" && maxSelections     ? { maxSelections }                 : {}),
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
   * Common checks (run for every ballot type):
   *   1. Is there an active election?
   *   2. Is the current time before endTime?
   *   3. Is the sender in the voter whitelist?
   *
   * Per-type payload rules (Vote.candidateId encoding):
   *   single-choice    candidateId is one candidate name from the list.
   *   yes-no           candidateId is exactly "yes" or "no".
   *   multiple-choice  candidateId is 1..maxSelections candidate names
   *                    joined by MULTI_CHOICE_SEPARATOR ("|"), with no
   *                    duplicates, and every name must be in the list.
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

    return this.validateBallotPayload(vote.candidateId);
  }

  /**
   * Decode + validate the `candidateId` payload according to the active
   * election type. Returns the same shape as `isVoteValid` so it can be
   * delegated to directly.
   */
  private validateBallotPayload(
    candidateId: string,
  ): { valid: boolean; reason?: string } {
    const cfg = this.config!; // safe: caller already null-checked

    if (cfg.type === "yes-no") {
      if (candidateId !== "yes" && candidateId !== "no") {
        return {
          valid: false,
          reason: `Invalid answer "${candidateId}". Expected "yes" or "no".`,
        };
      }
      return { valid: true };
    }

    if (cfg.type === "multiple-choice") {
      const selections = candidateId.split(MULTI_CHOICE_SEPARATOR);

      if (selections.length === 0 || selections.some((s) => s.length === 0)) {
        return { valid: false, reason: "Empty selection." };
      }

      const max = cfg.maxSelections ?? cfg.candidates.length;
      if (selections.length > max) {
        return {
          valid: false,
          reason: `Too many selections (${selections.length}). Max allowed: ${max}.`,
        };
      }

      const seen = new Set<string>();
      for (const sel of selections) {
        if (seen.has(sel)) {
          return { valid: false, reason: `Duplicate selection "${sel}".` };
        }
        seen.add(sel);

        if (!cfg.candidates.includes(sel)) {
          return {
            valid: false,
            reason: `Invalid candidate "${sel}". Valid: [${cfg.candidates.join(", ")}].`,
          };
        }
      }
      return { valid: true };
    }

    // Default: single-choice
    if (!cfg.candidates.includes(candidateId)) {
      return {
        valid: false,
        reason: `Invalid candidate "${candidateId}". Valid: [${cfg.candidates.join(", ")}].`,
      };
    }
    return { valid: true };
  }
}
