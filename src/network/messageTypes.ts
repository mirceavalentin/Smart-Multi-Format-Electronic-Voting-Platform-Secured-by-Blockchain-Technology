/**
 * messageTypes.ts — Typed message payloads for the RabbitMQ message bus.
 *
 * Every message published to a RabbitMQ exchange is a JSON-serialised object
 * that matches one of the interfaces below. The `type` field acts as a
 * discriminator so consumers can tell messages apart even if they end up on
 * the same queue (which doesn't happen in our design, but the discriminator
 * is good practice and aids debugging).
 *
 * MESSAGE TAXONOMY
 * ────────────────
 *  VOTE           Gateway → all Validators
 *                 A voter's signed ballot, published after HTTP validation.
 *                 Validators add it to their mempool so the next mining
 *                 cycle can seal it into a block.
 *
 *  ELECTION       Gateway → all nodes
 *                 The full election configuration (candidates, whitelist,
 *                 end time). Every node must activate the same election so
 *                 they all enforce identical voting rules.
 *
 *  BLOCK          Validator → all nodes
 *                 A freshly mined block. Receiving nodes append it to their
 *                 local chain (fast path) or trigger a full chain sync if
 *                 there is a gap.
 *
 *  CHAIN_REQUEST  Any node → all nodes (fanout)
 *                 Sent when a node can't append a received block (gap in
 *                 chain). Asks all peers to send their full chain to the
 *                 requester's private reply queue.
 *
 *  CHAIN_RESPONSE Any node → requesting node (direct)
 *                 Response to a CHAIN_REQUEST: the responder's full chain,
 *                 sent directly to the reply queue named in the request.
 */

import type { Block as IBlock } from "../models/block.js";
import type { Vote }            from "../models/vote.js";
import type { ElectionConfig }  from "../core/Election.js";

// ─── Discriminator union ────────────────────────────────────────────

export type MessageType =
  | "VOTE"
  | "ELECTION"
  | "BLOCK"
  | "CHAIN_REQUEST"
  | "CHAIN_RESPONSE";

// ─── Per-type payload interfaces ────────────────────────────────────

/** A validated, signed vote ready for the mempool. */
export interface VoteMessage {
  type: "VOTE";
  fromNode: string;
  vote: Vote;
}

/** Full election configuration to activate on all nodes. */
export interface ElectionMessage {
  type: "ELECTION";
  fromNode: string;
  config: ElectionConfig;
}

/** A block that was just mined and appended to a Validator's chain. */
export interface BlockMessage {
  type: "BLOCK";
  fromNode: string;
  block: IBlock;
}

/**
 * A request for a full chain from all peers.
 * The requester's private reply queue is embedded so every responder
 * knows exactly where to send the chain.
 */
export interface ChainRequestMessage {
  type: "CHAIN_REQUEST";
  fromNode: string;
  replyQueue: string;
}

/** A full chain sent in response to a CHAIN_REQUEST. */
export interface ChainResponseMessage {
  type: "CHAIN_RESPONSE";
  fromNode: string;
  chain: IBlock[];
}
