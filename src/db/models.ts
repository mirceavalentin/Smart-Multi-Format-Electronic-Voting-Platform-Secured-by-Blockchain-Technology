/**
 * ============================================================================
 *  db/models.ts — Mongoose schema definitions for blockchain entities.
 * ============================================================================
 *
 * Defines the Mongoose model for blocks so they can be persisted to MongoDB.
 * These schemas are separate from the TypeScript interfaces in src/models/
 * because Mongoose schemas need database-specific metadata (indexing, validation,
 * hooks, etc.) that doesn't belong in the domain model interfaces.
 */

import mongoose, { Schema, Document } from "mongoose";
import type { Block } from "../models/block.js";

/**
 * BlockDocument — extends the Block interface to include Mongoose metadata.
 * We don't extend Block directly since Mongoose adds its own _id field.
 */
export interface BlockDocument extends Document {
  index: number;
  timestamp: string;
  transactions: Array<{
    senderPublicKey: string;
    candidateId: string;
    electionId: string;
    timestamp: string;
    signature: string;
  }>;
  previousHash: string;
  hash: string;
  nonce: number;
}

/**
 * BlockSchema — the Mongoose schema for storing blocks in MongoDB.
 *
 * Fields:
 *   - index: The sequential block height (0 = genesis).
 *   - timestamp: ISO-8601 UTC timestamp of block creation.
 *   - transactions: Array of vote objects embedded in this block.
 *   - previousHash: Hex-encoded SHA-256 of the preceding block.
 *   - hash: Hex-encoded SHA-256 of this block's header.
 *   - nonce: Nonce used during block creation.
 *
 * Indexes:
 *   - { index: 1 }: efficient lookup by block height.
 *   - { hash: 1 }: efficient lookup by block hash (chain validation).
 */
const blockSchema = new Schema<BlockDocument>(
  {
    index: {
      type: Number,
      required: true,
      unique: true,
      index: true,
    },
    timestamp: {
      type: String, // ISO-8601
      required: true,
    },
    transactions: {
      type: [
        {
          senderPublicKey: String,
          candidateId: String,
          electionId: String,
          timestamp: String,
          signature: String,
        },
      ],
      default: [],
    },
    previousHash: {
      type: String, // hex
      required: true,
      index: true,
    },
    hash: {
      type: String, // hex
      required: true,
      index: true,
    },
    nonce: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true, // adds createdAt, updatedAt
  },
);

/**
 * BlockModel — the Mongoose model for saving/querying blocks.
 */
export const BlockModel = mongoose.model<BlockDocument>("Block", blockSchema);
