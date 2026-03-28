/**
 * ============================================================================
 *  index.ts — Application entry point (long-running server process).
 * ============================================================================
 *
 * This file boots the entire blockchain node:
 *   1. Connects to MongoDB (with retry logic so the app survives slow DB starts).
 *   2. Initialises the in-memory Blockchain (genesis block).
 *   3. Starts an Express HTTP server on the configured port.
 *
 * The Express server exposes two endpoints for initial testing:
 *   GET  /blocks  — return the full chain as JSON.
 *   POST /mine    — mine a new block with dummy vote data.
 *
 * The server.listen() call is what keeps the Node.js process (and thus
 * the container) alive indefinitely. Without it the container exits
 * immediately after the script finishes, which is what caused the
 * "exited" containers in the first podman-compose run.
 * ============================================================================
 */

import express from "express";
import mongoose from "mongoose";
import { Blockchain } from "./core/Blockchain.js";

// ─── Configuration via environment variables ────────────────────────
const HTTP_PORT: number = parseInt(process.env["HTTP_PORT"] ?? "3000", 10);
const MONGO_URI: string =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/voting_node_db";
const NODE_NAME: string = process.env["NODE_NAME"] ?? "node-local";

// ─── In-memory blockchain instance ──────────────────────────────────
const blockchain = new Blockchain();

// ─── Express app ────────────────────────────────────────────────────
const app = express();
app.use(express.json());

/**
 * GET /blocks
 *
 * Returns the full blockchain as a JSON array.
 * Useful for quick inspection and for MongoDB Compass comparisons.
 */
app.get("/blocks", (_req, res) => {
  res.json({
    node: NODE_NAME,
    length: blockchain.chain.length,
    isValid: blockchain.isChainValid(),
    blocks: blockchain.chain,
  });
});

/**
 * POST /mine
 *
 * Mines a new block with dummy vote data so we can test the chain
 * growth without a real voting client. In production this will be
 * replaced by a proper transaction-pool → block-creation pipeline.
 */
app.post("/mine", (_req, res) => {
  const dummyVote = {
    senderPublicKey: "04aabb...dummy",
    candidateId: "candidate-1",
    electionId: "election-2026",
    timestamp: new Date().toISOString(),
    signature: "deadbeef...dummy",
  };

  const newBlock = blockchain.addBlock([dummyVote]);

  res.status(201).json({
    message: "Block mined successfully",
    block: newBlock,
  });
});

/**
 * GET /health
 *
 * Lightweight liveness probe. Returns 200 if the process is up.
 * Not dependent on MongoDB — intentional, so the container is
 * considered "alive" even while waiting for the DB.
 */
app.get("/health", (_req, res) => {
  res.json({ status: "ok", node: NODE_NAME });
});

// ─── MongoDB connection with retry ──────────────────────────────────

/**
 * Attempt to connect to MongoDB, retrying on failure.
 *
 * WHY RETRY LOGIC?
 * In a containerised environment the app container often starts before
 * the MongoDB container has finished its initialisation (journal setup,
 * WiredTiger cache allocation, etc.). A naive one-shot connection
 * throws ECONNREFUSED and the process crashes, causing the container
 * to exit. The depends_on + healthcheck in docker-compose mitigates
 * this at the orchestrator level, but defence-in-depth demands that
 * the application also handles transient connection failures gracefully.
 */
async function connectWithRetry(
  uri: string,
  maxRetries: number = 10,
  delayMs: number = 3000,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await mongoose.connect(uri);
      console.log(`[${NODE_NAME}] Connected to MongoDB at ${uri}`);
      return;
    } catch (err) {
      console.warn(
        `[${NODE_NAME}] MongoDB connection attempt ${attempt}/${maxRetries} failed. ` +
        `Retrying in ${delayMs / 1000}s...`,
      );
      if (attempt === maxRetries) {
        console.error(`[${NODE_NAME}] Could not connect to MongoDB after ${maxRetries} attempts.`);
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// ─── Boot sequence ──────────────────────────────────────────────────

async function main(): Promise<void> {
  await connectWithRetry(MONGO_URI);

  app.listen(HTTP_PORT, () => {
    console.log(`[${NODE_NAME}] HTTP API listening on port ${HTTP_PORT}`);
    console.log(`[${NODE_NAME}] Genesis block hash: ${blockchain.chain[0]!.hash}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
