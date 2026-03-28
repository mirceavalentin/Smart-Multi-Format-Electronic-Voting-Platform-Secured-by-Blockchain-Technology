/**
 * ============================================================================
 *  server.ts — Single-file entry point for the voting node.
 * ============================================================================
 *
 * SINGLE-USE PROTOTYPE DESIGN (for thesis defence):
 *
 * This file wires up the entire node: Express HTTP routes (inline),
 * static-file serving for the web GUI, blockchain core, P2P gossip,
 * MongoDB persistence, and the auto-wipe mechanism.
 *
 * ARCHITECTURE — Proof of Authority (PoA) with Mempool
 * ────────────────────────────────────────────────────
 *
 *   **Gateway** (IS_VALIDATOR=false):
 *     - Serves the web GUI from `public/`.
 *     - Accepts POST /election and POST /vote from the browser.
 *     - Relays votes to all peers via P2P (BROADCAST_TRANSACTION).
 *     - Never creates blocks — it is an untrusted relay.
 *
 *   **Validator** (IS_VALIDATOR=true):
 *     - Receives votes via P2P and stores them in its TransactionPool.
 *     - Every VALIDATOR_INTERVAL_MS it drains the pool into a new block,
 *       persists it to MongoDB, and broadcasts the block to all peers.
 *
 * AUTO-WIPE (why + how):
 *
 *   After the election timer expires, each node:
 *     1. Tallies votes from the IMMUTABLE blockchain.
 *     2. Deletes ALL blocks from MongoDB   →  fresh DB for next demo.
 *     3. Resets the in-memory chain to just the genesis block.
 *     4. Clears the mempool and double-vote tracking set.
 *     5. Sets election.isActive = false.
 *
 *   This lets the thesis examiner run a full election lifecycle in ~60s
 *   and immediately start another round without restarting containers.
 * ============================================================================
 */

import path from "path";
import express, { type Request, type Response } from "express";
import { ethers } from "ethers";

import { connectToDatabase } from "./db/connection.js";
import { BlockModel } from "./db/models.js";
import { Blockchain } from "./core/Blockchain.js";
import { TransactionPool } from "./core/TransactionPool.js";
import { State } from "./core/State.js";
import { Election } from "./core/Election.js";
import { P2PNetwork } from "./network/p2p.js";
import {
  responseBlockchainMsg,
  broadcastTransactionMsg,
  electionCreatedMsg,
} from "./network/messageTypes.js";
import type { Vote } from "./models/vote.js";

// ─── Configuration from environment ─────────────────────────────────
const PORT: number = parseInt(process.env["PORT"] ?? process.env["HTTP_PORT"] ?? "3000", 10);
const P2P_PORT: number = parseInt(process.env["P2P_PORT"] ?? "6000", 10);
const MONGO_URI: string =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/voting_node_db";
const NODE_NAME: string = process.env["NODE_NAME"] ?? "node-local";
const IS_VALIDATOR: string = process.env["IS_VALIDATOR"] ?? "false";
const PEERS: string[] = (process.env["PEERS"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const VALIDATOR_INTERVAL_MS: number =
  parseInt(process.env["VALIDATOR_INTERVAL_MS"] ?? "15000", 10);

// ─── Core singletons ───────────────────────────────────────────────
const blockchain = new Blockchain();
const txPool = new TransactionPool();
const electionState = new State();
const election = new Election();
const p2pNetwork = new P2PNetwork(blockchain, txPool, election, NODE_NAME);

// Tally from the last completed election — set just before auto-wipe runs,
// so the GUI can still fetch results after the chain has been cleared.
let lastTally: Record<string, number> | null = null;

// ─── Express application ────────────────────────────────────────────
const app = express();
app.use(express.json());

/**
 * Serve the web GUI from the `public/` directory.
 *
 * In the Dockerfile, `public/` is copied next to `dist/`, so the
 * resolved path is `../public` relative to `dist/server.js`.
 * When running via ts-node from `src/`, it resolves to `../public`
 * relative to `src/server.ts` — same relative hop.
 */
app.use(express.static(path.join(__dirname, "..", "public")));

// ══════════════════════════════════════════════════════════════════════
//  HTTP ROUTES (inline — no separate api/ module)
// ══════════════════════════════════════════════════════════════════════

// ─── GET / — Health-check ───────────────────────────────────────────
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    status: "Node is alive",
    node: NODE_NAME,
    isValidator: IS_VALIDATOR,
    uptime: process.uptime(),
  });
});

// ─── GET /api/blocks — Full blockchain ──────────────────────────────
app.get("/api/blocks", (_req: Request, res: Response) => {
  res.json({
    node: NODE_NAME,
    length: blockchain.chain.length,
    isValid: blockchain.isChainValid(),
    blocks: blockchain.chain,
  });
});

// ─── GET /api/pool — Mempool contents ───────────────────────────────
app.get("/api/pool", (_req: Request, res: Response) => {
  res.json({
    node: NODE_NAME,
    pendingCount: txPool.size,
    transactions: txPool.getTransactions(),
  });
});

// ─── GET /api/peers — P2P peer info ─────────────────────────────────
app.get("/api/peers", (_req: Request, res: Response) => {
  res.json({
    node: NODE_NAME,
    connectedPeers: p2pNetwork.getPeerCount(),
    configuredPeers: PEERS,
  });
});

// ─── GET /api/election — Current election state ─────────────────────
app.get("/api/election", (_req: Request, res: Response) => {
  const config = election.getConfig();
  if (!config) {
    res.status(404).json({ error: "No active election." });
    return;
  }
  res.json({ node: NODE_NAME, election: config });
});

// ─── GET /api/election/status — Lightweight status for voter UI ──────
/**
 * Returns the minimal shape the Voter UI needs to decide whether to
 * show the ballot form. Reads directly from the in-memory Election
 * singleton (which is populated from the Genesis-Block-style config
 * broadcast to every node at election start).
 *
 * Response:
 *   { isActive: false }                              — no election
 *   { isActive: true, electionId, candidates,
 *     endTime, whitelist }                           — live election
 */
app.get("/api/election/status", (_req: Request, res: Response) => {
  const config = election.getConfig();
  if (!config || !config.isActive) {
    res.json({ isActive: false });
    return;
  }
  res.json({
    isActive: true,
    electionId: config.electionId,
    candidates: config.candidates,
    endTime: config.endTime,
    whitelist: config.whitelist,
  });
});

// ─── GET /api/election/results — Tally from last completed election ──
/**
 * Returns the vote counts computed just before the auto-wipe ran.
 * Safe to call after the chain has been wiped — the tally lives in
 * memory until the next election starts or the process restarts.
 */
app.get("/api/election/results", (_req: Request, res: Response) => {
  if (!lastTally) {
    res.json({ available: false });
    return;
  }
  const total = Object.values(lastTally).reduce((a, b) => a + b, 0);
  const sorted = Object.entries(lastTally).sort((a, b) => b[1] - a[1]);
  const winner = sorted[0]?.[0] ?? null;
  res.json({ available: true, winner, total, tally: lastTally });
});

// ─── POST /api/election — Create a new single-use election ─────────
/**
 * NO ADMIN KEY — simplified for thesis demo.
 *
 * The request body carries the plain election parameters:
 *   { candidates: string[], whitelist: string[], durationSeconds: number }
 *
 * The server computes endTime, activates the election in memory,
 * broadcasts the config to all peers via P2P, and schedules the
 * auto-wipe timer.
 */
app.post("/api/election", (req: Request, res: Response) => {
  const { candidates, whitelist, durationSeconds } = req.body;

  // ── Basic validation ──────────────────────────────────────────────
  if (!Array.isArray(candidates) || candidates.length === 0) {
    res.status(400).json({ error: "candidates must be a non-empty array." });
    return;
  }
  if (!Array.isArray(whitelist) || whitelist.length === 0) {
    res.status(400).json({ error: "whitelist must be a non-empty array." });
    return;
  }
  if (typeof durationSeconds !== "number" || durationSeconds <= 0) {
    res.status(400).json({ error: "durationSeconds must be a positive number." });
    return;
  }

  // ── Build election config ─────────────────────────────────────────
  const endTime = Date.now() + durationSeconds * 1000;
  const electionId = `election-${Date.now()}`;

  election.activate({ electionId, candidates, whitelist, endTime });

  // ── Broadcast to all peers so Validators know the rules ───────────
  const config = election.getConfig()!;
  p2pNetwork.broadcast(electionCreatedMsg(config));

  console.log(
    `[${NODE_NAME}] ✔ Election "${electionId}" started. ` +
    `Duration: ${durationSeconds}s, Candidates: [${candidates.join(", ")}], ` +
    `Whitelist size: ${whitelist.length}`,
  );

  // ──────────────────────────────────────────────────────────────────
  //  AUTO-WIPE TIMER
  // ──────────────────────────────────────────────────────────────────
  //
  //  This setTimeout fires when the election window closes. It:
  //    1. Tallies votes from the immutable blockchain.
  //    2. Wipes all blocks from MongoDB (fresh slate for next demo).
  //    3. Resets in-memory chain, mempool, double-vote set.
  //    4. Deactivates the election.
  //
  //  WHY AUTO-WIPE?
  //  In a thesis defence, the examiner wants to see a complete election
  //  lifecycle in ~60 seconds, then immediately start another one. The
  //  auto-wipe makes this possible without restarting containers or
  //  manually clearing databases. It turns the prototype into a
  //  "single-use, infinitely repeatable" demo system.
  //
  //  WHY TALLY FROM THE CHAIN (NOT A COUNTER)?
  //  The blockchain is the single source of truth. Reading votes from
  //  sealed, hash-linked blocks guarantees determinism, auditability,
  //  and tamper-evidence — core blockchain properties we want to
  //  demonstrate in the thesis.
  // ──────────────────────────────────────────────────────────────────
  setTimeout(async () => {
    console.log(
      `\n[${NODE_NAME}] ══════════════════════════════════════════════════\n` +
      `[${NODE_NAME}]  ELECTION TALLY — "${electionId}"\n` +
      `[${NODE_NAME}] ══════════════════════════════════════════════════`,
    );

    // ── Step 1: Tally votes from the immutable chain ────────────────
    const allVotes: Vote[] = [];
    for (const block of blockchain.chain) {
      for (const tx of block.transactions) {
        allVotes.push(tx);
      }
    }

    const electionVotes = allVotes.filter((v) => v.electionId === electionId);
    const tallyMap = new Map<string, number>();
    for (const c of candidates) tallyMap.set(c, 0);
    for (const v of electionVotes) {
      tallyMap.set(v.candidateId, (tallyMap.get(v.candidateId) ?? 0) + 1);
    }

    const sorted = [...tallyMap.entries()].sort((a, b) => b[1] - a[1]);
    lastTally = Object.fromEntries(tallyMap);  // capture before the wipe
    console.log(`[${NODE_NAME}]  Total votes on chain: ${allVotes.length}`);
    console.log(`[${NODE_NAME}]  Votes for this election: ${electionVotes.length}`);
    console.log(`[${NODE_NAME}]  ──────────────────────────────────────────`);
    for (const [candidate, count] of sorted) {
      const pct = electionVotes.length > 0
        ? ((count / electionVotes.length) * 100).toFixed(1)
        : "0.0";
      console.log(`[${NODE_NAME}]    ${candidate}: ${count} vote(s) (${pct}%)`);
    }
    if (sorted.length > 0 && sorted[0]) {
      console.log(
        `[${NODE_NAME}]  ──────────────────────────────────────────\n` +
        `[${NODE_NAME}]  🏆 WINNER: ${sorted[0][0]} with ${sorted[0][1]} vote(s)\n` +
        `[${NODE_NAME}] ══════════════════════════════════════════════════\n`,
      );
    }

    // ── Step 2: Wipe MongoDB blocks (fresh slate for next demo) ─────
    //
    // AUTO-WIPE: deleting all blocks from the database so the next
    // election starts with a clean chain. This is the key mechanism
    // that makes the demo infinitely repeatable.
    try {
      const deleted = await BlockModel.deleteMany({});
      console.log(`[${NODE_NAME}] 🗑 Auto-wipe: deleted ${deleted.deletedCount} block(s) from MongoDB.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${NODE_NAME}] Auto-wipe DB delete failed: ${msg}`);
    }

    // ── Step 3: Reset in-memory state ───────────────────────────────
    //
    // AUTO-WIPE: reset the in-memory blockchain to just the genesis
    // block, clear the mempool, and clear the double-vote tracker.
    blockchain.resetToGenesis();
    txPool.clearPool();
    electionState.clear();
    election.deactivate();

    // Re-persist genesis for the fresh chain
    const genesisBlock = blockchain.chain[0]!;
    try {
      await BlockModel.create({
        index: genesisBlock.index,
        timestamp: genesisBlock.timestamp,
        transactions: genesisBlock.transactions,
        previousHash: genesisBlock.previousHash,
        hash: genesisBlock.hash,
        nonce: genesisBlock.nonce,
      });
      console.log(`[${NODE_NAME}] ✔ Fresh genesis block persisted after auto-wipe.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${NODE_NAME}] Failed to re-persist genesis: ${msg}`);
    }

    console.log(`[${NODE_NAME}] ✔ Auto-wipe complete. Ready for a new election.\n`);
  }, durationSeconds * 1000);

  res.status(201).json({
    message: "Election created and broadcast.",
    election: config,
  });
});

// ─── POST /api/vote — Submit a signed vote ──────────────────────────
/**
 * VALIDATION PIPELINE (3 layers):
 *   Layer 1 — Election rules (whitelist, candidate, time window).
 *   Layer 2 — Double-vote prevention (State Set<string>).
 *   Layer 3 — ECDSA signature verification (ethers.verifyMessage).
 */
app.post("/api/vote", (req: Request, res: Response) => {
  const vote = req.body;

  // ── Layer 1: Election rules ─────────────────────────────────────
  const check = election.isVoteValid(vote);
  if (!check.valid) {
    res.status(400).json({ error: check.reason });
    return;
  }

  // ── Layer 2: Double-vote prevention ─────────────────────────────
  if (electionState.hasVoted(vote.senderPublicKey)) {
    res.status(400).json({ error: "This address has already voted." });
    return;
  }

  // ── Layer 3: ECDSA signature verification ───────────────────────
  try {
    const { senderPublicKey, candidateId, electionId, timestamp, signature } = vote;

    const canonicalPayload = JSON.stringify({
      senderPublicKey,
      candidateId,
      electionId,
      timestamp,
    });

    const recoveredAddress: string = ethers.verifyMessage(canonicalPayload, signature);

    if (recoveredAddress.toLowerCase() !== senderPublicKey.toLowerCase()) {
      res.status(400).json({ error: "Invalid signature." });
      return;
    }
  } catch {
    res.status(400).json({ error: "Invalid signature." });
    return;
  }

  // ── Accepted → mempool + gossip ─────────────────────────────────
  electionState.markVoted(vote.senderPublicKey);
  txPool.addTransaction(vote);
  p2pNetwork.broadcast(broadcastTransactionMsg(vote));

  console.log(
    `[${NODE_NAME}] ✔ Vote accepted from ${vote.senderPublicKey} ` +
    `(pool: ${txPool.size}, voters: ${electionState.voterCount}).`,
  );

  res.status(200).json({ message: "Vote accepted." });
});

// ══════════════════════════════════════════════════════════════════════
//  BOOT SEQUENCE
// ══════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  await connectToDatabase(MONGO_URI);

  // Persist genesis block if not already present
  const genesisBlock = blockchain.chain[0]!;
  try {
    const existing = await BlockModel.findOne({ index: 0 });
    if (!existing) {
      await BlockModel.create({
        index: genesisBlock.index,
        timestamp: genesisBlock.timestamp,
        transactions: genesisBlock.transactions,
        previousHash: genesisBlock.previousHash,
        hash: genesisBlock.hash,
        nonce: genesisBlock.nonce,
      });
      console.log(`[${NODE_NAME}] ✔ Genesis block persisted (hash: ${genesisBlock.hash}).`);
    } else {
      console.log(`[${NODE_NAME}] ℹ Genesis block already in MongoDB.`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${NODE_NAME}] Genesis persist failed: ${msg}`);
    throw err;
  }

  // Start P2P
  p2pNetwork.startServer(P2P_PORT);

  if (PEERS.length > 0) {
    console.log(`[${NODE_NAME}] Connecting to ${PEERS.length} seed peer(s)...`);
    setTimeout(() => p2pNetwork.connectToPeers(PEERS), 5000);
  }

  // Start HTTP
  app.listen(PORT, () => {
    console.log(`[${NODE_NAME}] Server running on port ${PORT}`);
    console.log(`[${NODE_NAME}] Role: ${IS_VALIDATOR === "true" ? "VALIDATOR" : "GATEWAY"}`);
    console.log(`[${NODE_NAME}] P2P port: ${P2P_PORT} | Seed peers: ${PEERS.length}`);
  });

  // ── Validator mining loop ─────────────────────────────────────────
  if (IS_VALIDATOR === "true") {
    console.log(
      `[${NODE_NAME}] ⛏ Validator mining loop started (interval: ${VALIDATOR_INTERVAL_MS / 1000}s).`,
    );

    setInterval(async () => {
      if (txPool.size === 0) return;

      console.log(`[${NODE_NAME}] ⛏ Mining — ${txPool.size} pending vote(s).`);

      try {
        const pendingVotes = txPool.getTransactions();
        txPool.clearPool();

        const newBlock = blockchain.addBlock(pendingVotes);

        await BlockModel.create({
          index: newBlock.index,
          timestamp: newBlock.timestamp,
          transactions: newBlock.transactions,
          previousHash: newBlock.previousHash,
          hash: newBlock.hash,
          nonce: newBlock.nonce,
        });
        console.log(
          `[${NODE_NAME}] ⛏ Block ${newBlock.index} mined ` +
          `(${pendingVotes.length} vote(s), hash: ${newBlock.hash}).`,
        );

        p2pNetwork.broadcast(responseBlockchainMsg([newBlock]));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${NODE_NAME}] ⛏ Mining failed: ${msg}`);
      }
    }, VALIDATOR_INTERVAL_MS);
  } else {
    console.log(`[${NODE_NAME}] ℹ Running as GATEWAY — no mining loop.`);
  }
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
