/**
 * ============================================================================
 *  network/messageTypes.ts — P2P protocol message definitions.
 * ============================================================================
 *
 * CONCEPTUAL BACKGROUND (for academic defence):
 *
 * In any distributed system, nodes must agree on a **wire protocol** — a
 * fixed set of message types and their payloads. Our blockchain P2P layer
 * uses a simple JSON-based protocol over WebSockets with four message types:
 *
 *   QUERY_LATEST          — "What is your latest block?"
 *   QUERY_ALL             — "Send me your entire chain."
 *   RESPONSE_BLOCKCHAIN   — "Here is chain data (one block or the full chain)."
 *   BROADCAST_TRANSACTION — "Here is a new pending vote for the mempool."
 *
 * The fourth type was introduced with the Proof-of-Authority (PoA) mempool
 * architecture: votes arrive at the Gateway via HTTP, and the Gateway gossips
 * them to all peers (including Validators) via BROADCAST_TRANSACTION. This
 * ensures every Validator's local TransactionPool contains the pending votes,
 * ready to be sealed into blocks on the next mining cycle.
 *
 * Each message is serialised as a JSON object with a `type` discriminator
 * and a `data` payload. TypeScript's discriminated union pattern lets us
 * exhaustively type-check message handling at compile time.
 * ============================================================================
 */

import type { Block as IBlock } from "../models/block.js";
import type { Vote } from "../models/vote.js";
import type { ElectionConfig } from "../core/Election.js";

/**
 * Enum of all P2P message types.
 *
 * Using a numeric enum for compact wire representation. The string
 * names appear in logs for readability.
 */
export enum MessageType {
  /** Request the peer's latest (tip) block. */
  QUERY_LATEST = 0,

  /** Request the peer's entire chain. */
  QUERY_ALL = 1,

  /** Carry blockchain data (one or more blocks). */
  RESPONSE_BLOCKCHAIN = 2,

  /**
   * Carry a single pending vote (transaction) for the mempool.
   *
   * Introduced for the PoA architecture: the Gateway broadcasts each
   * incoming vote to all peers so that every Validator's TransactionPool
   * is populated before the next mining cycle.
   */
  BROADCAST_TRANSACTION = 3,

  /**
   * Carry an election configuration created by the Administrator.
   *
   * When the Admin creates an election via POST /election on the Gateway,
   * the Gateway broadcasts this message to all Validators. Each Validator
   * then persists the election config to its own MongoDB and updates its
   * local ElectionManager, so that every node in the network enforces
   * the same election rules (whitelist, candidates, time window).
   *
   * This is the mechanism by which a single admin action propagates the
   * election state across the entire distributed network — analogous to
   * a "configuration transaction" in enterprise blockchain frameworks.
   */
  ELECTION_CREATED = 4,
}

/**
 * The P2P message envelope.
 *
 * Every message sent over the WebSocket connection is serialised as
 * JSON matching this interface. The `type` discriminator tells the
 * receiver how to interpret `data`.
 */
export interface P2PMessage {
  type: MessageType;
  data: string; // JSON-stringified payload (IBlock[] for RESPONSE_BLOCKCHAIN, null for queries)
}

// ─── Factory helpers ────────────────────────────────────────────────

/** Build a QUERY_LATEST message. */
export function queryLatestMsg(): P2PMessage {
  return { type: MessageType.QUERY_LATEST, data: "" };
}

/** Build a QUERY_ALL message. */
export function queryAllMsg(): P2PMessage {
  return { type: MessageType.QUERY_ALL, data: "" };
}

/** Build a RESPONSE_BLOCKCHAIN message carrying the given blocks. */
export function responseBlockchainMsg(blocks: IBlock[]): P2PMessage {
  return { type: MessageType.RESPONSE_BLOCKCHAIN, data: JSON.stringify(blocks) };
}

/**
 * Build a BROADCAST_TRANSACTION message carrying a single pending vote.
 *
 * The vote is JSON-stringified in the `data` field. Receiving nodes
 * parse it and add it to their local TransactionPool.
 */
export function broadcastTransactionMsg(vote: Vote): P2PMessage {
  return { type: MessageType.BROADCAST_TRANSACTION, data: JSON.stringify(vote) };
}

/**
 * Build an ELECTION_CREATED message carrying the full election config.
 *
 * The election configuration (candidates, whitelist, time window) is
 * JSON-stringified in the `data` field. Receiving nodes parse it,
 * persist it to their MongoDB, and update their ElectionManager.
 */
export function electionCreatedMsg(config: ElectionConfig): P2PMessage {
  return { type: MessageType.ELECTION_CREATED, data: JSON.stringify(config) };
}
