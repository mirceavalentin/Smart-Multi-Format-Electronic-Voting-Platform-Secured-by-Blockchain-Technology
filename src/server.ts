/**
 * server.ts — Single entry point for a voting node.
 *
 * WHAT THIS FILE DOES
 * ───────────────────
 * 1. Reads configuration from environment variables (via utils/config.ts).
 * 2. Connects to MongoDB (for persistent block storage).
 * 3. Connects to the RabbitMQ message bus (for inter-node communication).
 * 4. Registers RabbitMQ subscriptions so this node reacts to votes,
 *    election configs, and new blocks from other nodes.
 * 5. Starts the Express HTTP server with all API routes.
 * 6. If this node is a Validator, starts the mining loop.
 *
 * NODE ROLES
 * ──────────
 * Gateway  (IS_VALIDATOR=false)
 *   • Serves the web UI from public/.
 *   • Accepts POST /api/election and POST /api/vote from browsers.
 *   • Publishes accepted votes and election configs to RabbitMQ.
 *   • Never mines blocks.
 *
 * Validator (IS_VALIDATOR=true)
 *   • Subscribes to vote and block messages from RabbitMQ.
 *   • Drains its mempool into a new block every VALIDATOR_INTERVAL_MS.
 *   • Publishes newly mined blocks to RabbitMQ for chain sync.
 *   • Does not expose its HTTP port externally.
 *
 * AUTO-WIPE
 * ─────────
 * After the election timer expires, every node (Gateway and Validators alike)
 * runs the auto-wipe sequence:
 *   1. Tallies votes from the immutable chain (Gateway only — for the results API).
 *   2. Deletes all blocks from MongoDB.
 *   3. Resets the in-memory chain to just the genesis block.
 *   4. Clears the mempool and double-vote tracker.
 *   5. Re-persists the fresh genesis block so MongoDB stays consistent.
 *
 * The Gateway triggers its auto-wipe from the POST /api/election handler.
 * Validators trigger theirs from the ELECTION message subscription.
 * Both call the shared `scheduleAutoWipe()` helper below.
 */

import path from "path";
import express, { type Request, type Response } from "express";
import { ethers } from "ethers";

import { loadConfig }            from "./utils/config.js";
import { connectToDatabase }     from "./db/connection.js";
import { BlockModel }            from "./db/models.js";
import { Blockchain }            from "./core/Blockchain.js";
import { TransactionPool }       from "./core/TransactionPool.js";
import { State }                 from "./core/State.js";
import { Election, MULTI_CHOICE_SEPARATOR } from "./core/Election.js";
import type { ElectionConfig, ElectionType } from "./core/Election.js";
import { MessageBus }            from "./network/messageBus.js";
import { ChainSyncService }      from "./network/chainSyncService.js";
import { TransactionGossipService } from "./network/transactionGossipService.js";
import type { Vote }             from "./models/vote.js";
import type { Block as IBlock }  from "./models/block.js";

// ── Configuration ─────────────────────────────────────────────────
const config = loadConfig();

// ── Core singletons ───────────────────────────────────────────────
// These objects hold ALL in-memory state for this node. They are created
// once and shared across the HTTP handlers, mining loop, and message
// bus subscriptions.
const blockchain    = new Blockchain();
const txPool        = new TransactionPool();
const electionState = new State();       // tracks who has already voted
const election      = new Election();    // holds the current election config
const messageBus    = new MessageBus(config.nodeName);

// Stores the tally from the last completed election so the Gateway can
// serve GET /api/election/results even after the chain has been wiped.
let lastTally: Record<string, number> | null = null;

// ── Chain sync service ────────────────────────────────────────────
// Wires the sync logic to the message bus: when a block is appended we
// publish it, and when we need the full chain we ask the bus to fetch it.
const chainSync = new ChainSyncService(
  blockchain,
  txPool,
  config.nodeName,
  (block: IBlock) => messageBus.publishBlock(block),
  ()              => messageBus.requestFullChain(),
);

// Gossip service: parses raw vote payloads and adds them to the mempool.
const gossipService = new TransactionGossipService(txPool, config.nodeName);

// ── Express application ────────────────────────────────────────────
const app = express();
app.use(express.json());

// Serve the voter and admin UIs from the public/ directory.
// In the container the path resolves to /app/public/ (see Dockerfile).
app.use(express.static(path.join(__dirname, "..", "public")));

// ══════════════════════════════════════════════════════════════════
//  HTTP ROUTES
// ══════════════════════════════════════════════════════════════════

// ── GET /api/health ── node liveness check ──────────────────────
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    status:      "Node is alive",
    node:        config.nodeName,
    isValidator: config.isValidator,
    uptime:      process.uptime(),
  });
});

// ── GET /api/blocks ── full blockchain ─────────────────────────
app.get("/api/blocks", (_req: Request, res: Response) => {
  res.json({
    node:     config.nodeName,
    length:   blockchain.chain.length,
    isValid:  blockchain.isChainValid(),
    blocks:   blockchain.chain,
  });
});

// ── GET /api/pool ── mempool contents ──────────────────────────
app.get("/api/pool", (_req: Request, res: Response) => {
  res.json({
    node:         config.nodeName,
    pendingCount: txPool.size,
    transactions: txPool.getTransactions(),
  });
});

// ── GET /api/peers ── message bus status ───────────────────────
// Previously returned WebSocket peer counts. Now reports RabbitMQ
// connection status since the P2P layer no longer exists.
app.get("/api/peers", (_req: Request, res: Response) => {
  res.json({
    node:       config.nodeName,
    messageBus: messageBus.isConnected ? "connected" : "disconnected",
    // Mask credentials from the URL before returning it to the client.
    brokerUrl:  config.rabbitmqUrl.replace(/:\/\/[^@]*@/, "://***@"),
  });
});

// ── GET /api/election ── current election config ────────────────
app.get("/api/election", (_req: Request, res: Response) => {
  const cfg = election.getConfig();
  if (!cfg) {
    res.status(404).json({ error: "No active election." });
    return;
  }
  res.json({ node: config.nodeName, election: cfg });
});

// ── GET /api/election/status ── lightweight status for the voter UI
// Returns only the fields the ballot form needs so the UI doesn't have
// to parse the full election object.
app.get("/api/election/status", (_req: Request, res: Response) => {
  const cfg = election.getConfig();
  if (!cfg || !cfg.isActive) {
    res.json({ isActive: false });
    return;
  }
  res.json({
    isActive:      true,
    electionId:    cfg.electionId,
    type:          cfg.type,
    candidates:    cfg.candidates,
    endTime:       cfg.endTime,
    whitelist:     cfg.whitelist,
    ...(cfg.question      ? { question:      cfg.question }      : {}),
    ...(cfg.maxSelections ? { maxSelections: cfg.maxSelections } : {}),
  });
});

// ── GET /api/election/results ── tally from the last completed election
// The tally is computed just before the auto-wipe runs and stored in
// `lastTally`. It remains available until the next election starts.
app.get("/api/election/results", (_req: Request, res: Response) => {
  if (!lastTally) {
    res.json({ available: false });
    return;
  }
  const total  = Object.values(lastTally).reduce((a, b) => a + b, 0);
  const sorted = Object.entries(lastTally).sort(([, a], [, b]) => b - a);
  const winner = sorted[0]?.[0] ?? null;
  res.json({ available: true, winner, total, tally: lastTally });
});

// ── POST /api/election ── create a new election (Gateway only) ──
/**
 * NO ADMIN KEY — simplified for the thesis demo.
 *
 * Request body:
 *   {
 *     type?:            "single-choice" | "multiple-choice" | "yes-no",
 *     candidates:       string[],   // ignored if type === "yes-no"
 *     whitelist:        string[],
 *     durationSeconds:  number,
 *     question?:        string,     // yes-no only (the referendum prompt)
 *     maxSelections?:   number,     // multiple-choice only (defaults to N)
 *   }
 *
 * On success, activates the election on this node, broadcasts the config
 * to all peers via RabbitMQ, and schedules the auto-wipe timer.
 */
app.post("/api/election", (req: Request, res: Response) => {
  const {
    type,
    candidates,
    whitelist,
    durationSeconds,
    question,
    maxSelections,
  } = req.body as {
    type?: unknown;
    candidates: unknown;
    whitelist: unknown;
    durationSeconds: unknown;
    question?: unknown;
    maxSelections?: unknown;
  };

  // ── Type discriminator ─────────────────────────────────────────
  const electionType: ElectionType =
    type === "multiple-choice" || type === "yes-no" ? type : "single-choice";

  // ── Always-required fields ─────────────────────────────────────
  if (!Array.isArray(whitelist) || whitelist.length === 0) {
    res.status(400).json({ error: "whitelist must be a non-empty array." });
    return;
  }
  if (typeof durationSeconds !== "number" || durationSeconds <= 0) {
    res.status(400).json({ error: "durationSeconds must be a positive number." });
    return;
  }

  // ── Candidate / question rules per type ────────────────────────
  if (electionType === "yes-no") {
    if (typeof question !== "string" || question.trim().length === 0) {
      res.status(400).json({ error: "yes-no elections require a non-empty 'question'." });
      return;
    }
  } else {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      res.status(400).json({ error: "candidates must be a non-empty array." });
      return;
    }
    if ((candidates as string[]).some((c) => c.includes(MULTI_CHOICE_SEPARATOR))) {
      res.status(400).json({
        error: `Candidate names must not contain the "${MULTI_CHOICE_SEPARATOR}" character.`,
      });
      return;
    }
    if (electionType === "multiple-choice" && maxSelections !== undefined) {
      if (
        typeof maxSelections !== "number" ||
        maxSelections < 1 ||
        maxSelections > (candidates as string[]).length
      ) {
        res.status(400).json({
          error: `maxSelections must be a number between 1 and ${(candidates as string[]).length}.`,
        });
        return;
      }
    }
  }

  const endTime    = Date.now() + durationSeconds * 1000;
  const electionId = `election-${Date.now()}`;

  lastTally = null; // clear results from any previous election

  election.activate({
    electionId,
    type:       electionType,
    candidates: electionType === "yes-no" ? [] : (candidates as string[]),
    whitelist:  whitelist as string[],
    endTime,
    ...(electionType === "yes-no"
      ? { question: (question as string).trim() }
      : {}),
    ...(electionType === "multiple-choice" && typeof maxSelections === "number"
      ? { maxSelections }
      : {}),
  });

  const cfg = election.getConfig()!;

  // Broadcast the election config to all Validators via RabbitMQ.
  messageBus.publishElection(cfg);

  console.log(
    `[${config.nodeName}] Election "${electionId}" started ` +
    `(type: ${cfg.type}). ` +
    `Duration: ${durationSeconds}s, Candidates: [${cfg.candidates.join(", ")}], ` +
    `Whitelist: ${(whitelist as string[]).length} address(es)` +
    (cfg.maxSelections ? `, maxSelections: ${cfg.maxSelections}` : "") +
    (cfg.question      ? `, question: "${cfg.question}"`          : "") +
    `.`,
  );

  // Schedule the auto-wipe for the Gateway.
  // Validators schedule their own wipe when they receive the ELECTION message.
  scheduleAutoWipe(cfg, durationSeconds * 1000, (tally) => {
    lastTally = tally; // save tally so results endpoint keeps working after wipe
  });

  res.status(201).json({ message: "Election created and broadcast.", election: cfg });
});

// ── POST /api/vote ── submit a signed vote ──────────────────────
/**
 * VALIDATION PIPELINE (3 layers):
 *   1. Election rules — active election, time window, whitelist, valid candidate.
 *   2. Double-vote prevention — in-memory State set keyed by voter address.
 *   3. ECDSA signature — ethers.verifyMessage recovers the signer address and
 *      compares it against senderPublicKey.
 */
app.post("/api/vote", (req: Request, res: Response) => {
  const vote = req.body as Vote;

  // Layer 1: election rules
  const check = election.isVoteValid(vote);
  if (!check.valid) {
    res.status(400).json({ error: check.reason });
    return;
  }

  // Layer 2: double-vote prevention
  if (electionState.hasVoted(vote.senderPublicKey)) {
    res.status(400).json({ error: "This address has already voted." });
    return;
  }

  // Layer 3: ECDSA signature verification
  try {
    const { senderPublicKey, candidateId, electionId, timestamp, signature } = vote;

    // The canonical payload is identical to what the client signed.
    // JSON.stringify key order must match exactly — see voter UI.
    const payload = JSON.stringify({ senderPublicKey, candidateId, electionId, timestamp });

    const recovered: string = ethers.verifyMessage(payload, signature);
    if (recovered.toLowerCase() !== senderPublicKey.toLowerCase()) {
      res.status(400).json({ error: "Invalid signature." });
      return;
    }
  } catch {
    res.status(400).json({ error: "Invalid signature." });
    return;
  }

  // All checks passed — record the vote and broadcast it.
  electionState.markVoted(vote.senderPublicKey);
  txPool.addTransaction(vote);
  messageBus.publishVote(vote);

  console.log(
    `[${config.nodeName}] Vote accepted from ${vote.senderPublicKey.slice(0, 10)}… ` +
    `(pool: ${txPool.size}, unique voters: ${electionState.voterCount}).`,
  );

  res.status(200).json({ message: "Vote accepted." });
});

// ══════════════════════════════════════════════════════════════════
//  AUTO-WIPE HELPER
// ══════════════════════════════════════════════════════════════════

/**
 * Schedule the post-election cleanup for this node.
 *
 * Both the Gateway (from POST /api/election) and Validators (from the
 * ELECTION message subscription) call this function so the cleanup
 * always fires at the right time regardless of node role.
 *
 * Steps (run after delayMs):
 *   1. Optional: compute and pass the tally to `onPreWipe` (Gateway only).
 *   2. Delete all blocks from MongoDB.
 *   3. Reset the in-memory chain to genesis.
 *   4. Clear the mempool and voter-address set.
 *   5. Re-persist the fresh genesis block so MongoDB and memory stay in sync.
 *
 * @param cfg         The election config (used to scope the vote tally).
 * @param delayMs     Milliseconds until the wipe fires.
 * @param onPreWipe   Optional callback that receives the final tally before
 *                    the chain is wiped (used by the Gateway to store results).
 */
function scheduleAutoWipe(
  cfg: ElectionConfig,
  delayMs: number,
  onPreWipe?: (tally: Record<string, number>) => void,
): void {
  setTimeout(async () => {
    console.log(
      `\n[${config.nodeName}] ══ AUTO-WIPE: election "${cfg.electionId}" ══`,
    );

    // ── Step 1: Tally ─────────────────────────────────────────────
    if (onPreWipe) {
      // Collect every vote from every block, filtered to this election.
      const votes: Vote[] = blockchain.chain.flatMap((b) => b.transactions);
      const electionVotes = votes.filter((v) => v.electionId === cfg.electionId);

      // Initial buckets depend on the election type.
      //   single-choice / multiple-choice: one bucket per candidate.
      //   yes-no:                          two buckets, "yes" and "no".
      const initialBuckets: [string, number][] =
        cfg.type === "yes-no"
          ? [["yes", 0], ["no", 0]]
          : cfg.candidates.map((c) => [c, 0]);

      const tally = new Map<string, number>(initialBuckets);

      // Count selections from every sealed ballot.
      // For multiple-choice, a single ballot contributes one point to
      // each candidate it approved (approval voting) — so we split the
      // pipe-delimited candidateId.
      for (const v of electionVotes) {
        const selections =
          cfg.type === "multiple-choice"
            ? v.candidateId.split(MULTI_CHOICE_SEPARATOR)
            : [v.candidateId];

        for (const sel of selections) {
          if (tally.has(sel)) {
            tally.set(sel, tally.get(sel)! + 1);
          }
        }
      }

      const sorted = [...tally.entries()].sort(([, a], [, b]) => b - a);
      console.log(`[${config.nodeName}]  Election type: ${cfg.type}`);
      console.log(`[${config.nodeName}]  Total ballots sealed on chain: ${electionVotes.length}`);
      const denominator =
        cfg.type === "multiple-choice"
          ? [...tally.values()].reduce((a, b) => a + b, 0) // total approvals
          : electionVotes.length;
      for (const [option, count] of sorted) {
        const pct = denominator > 0
          ? ((count / denominator) * 100).toFixed(1)
          : "0.0";
        console.log(`[${config.nodeName}]    ${option}: ${count} (${pct}%)`);
      }
      if (sorted[0]) {
        console.log(`[${config.nodeName}]  Winner: ${sorted[0][0]} with ${sorted[0][1]} point(s)`);
      }

      onPreWipe(Object.fromEntries(tally));
    }

    // ── Step 2: Wipe MongoDB ──────────────────────────────────────
    try {
      const { deletedCount } = await BlockModel.deleteMany({});
      console.log(`[${config.nodeName}]  Deleted ${deletedCount} block(s) from MongoDB.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${config.nodeName}]  MongoDB wipe failed: ${msg}`);
    }

    // ── Step 3: Reset in-memory state ────────────────────────────
    blockchain.resetToGenesis();
    txPool.clearPool();
    electionState.clear();
    election.deactivate();

    // ── Step 4: Re-persist genesis ────────────────────────────────
    // After resetToGenesis(), chain[0] is a fresh genesis block.
    // We persist it immediately so MongoDB never ends up empty.
    const genesis = blockchain.chain[0]!;
    try {
      await BlockModel.create(genesis.toJSON());
      console.log(`[${config.nodeName}]  Fresh genesis block persisted.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${config.nodeName}]  Failed to persist genesis: ${msg}`);
    }

    console.log(`[${config.nodeName}] ══ AUTO-WIPE COMPLETE. Ready for next election. ══\n`);
  }, delayMs);
}

// ══════════════════════════════════════════════════════════════════
//  BOOT SEQUENCE
// ══════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  // ── 1. MongoDB ────────────────────────────────────────────────
  await connectToDatabase(config.mongoUri);

  // Remove any blocks left from a previous process run. The in-memory
  // chain always starts from a fresh genesis, so stale DB blocks would
  // cause a mismatch between memory and persistence.
  const { deletedCount: stale } = await BlockModel.deleteMany({});
  if (stale > 0) {
    console.log(`[${config.nodeName}] Boot: removed ${stale} stale block(s) from MongoDB.`);
  }

  // Persist the in-memory genesis block so MongoDB is never empty.
  const genesis = blockchain.chain[0]!;
  await BlockModel.create(genesis.toJSON());
  console.log(`[${config.nodeName}] Genesis block persisted (hash: ${genesis.hash.slice(0, 12)}…).`);

  // ── 2. RabbitMQ ───────────────────────────────────────────────
  await messageBus.connect(config.rabbitmqUrl);

  // ── 3. Message bus subscriptions ─────────────────────────────

  // All nodes (Gateway and Validators) subscribe to election messages
  // so every node enforces identical election rules.
  await messageBus.subscribeToElections((cfg: ElectionConfig) => {
    console.log(`[${config.nodeName}] Received ELECTION "${cfg.electionId}" — activating.`);
    election.activate(cfg);

    // Validators schedule their own auto-wipe timer here.
    // (The Gateway already scheduled it in POST /api/election.)
    const delay = Math.max(0, cfg.endTime - Date.now());
    scheduleAutoWipe(cfg, delay);
  });

  // All nodes subscribe to block messages to keep their chains in sync.
  await messageBus.subscribeToBlocks((block: IBlock, fromNode: string) => {
    console.log(
      `[${config.nodeName}] Received BLOCK ${block.index} from ${fromNode}.`,
    );
    chainSync.handleReceivedBlock(JSON.stringify(block));
  });

  // All nodes respond to chain sync requests so any node that falls behind
  // can recover its chain.
  await messageBus.subscribeToChainRequests(async (replyQueue: string) => {
    console.log(`[${config.nodeName}] Received CHAIN_REQUEST — responding with full chain.`);
    await messageBus.publishChainResponse(replyQueue, blockchain.chain);
  });

  // Validators subscribe to vote messages to populate their mempool.
  // The Gateway does NOT subscribe here — it adds votes to the pool
  // directly in POST /api/vote before publishing to RabbitMQ, to
  // avoid adding the same vote twice.
  if (config.isValidator) {
    await messageBus.subscribeToVotes((vote: Vote) => {
      gossipService.handleIncomingVote(JSON.stringify(vote));
    });
  }

  // ── 4. HTTP server ────────────────────────────────────────────
  app.listen(config.httpPort, () => {
    console.log(`[${config.nodeName}] HTTP server on port ${config.httpPort}.`);
    console.log(`[${config.nodeName}] Role: ${config.isValidator ? "VALIDATOR" : "GATEWAY"}.`);
  });

  // ── 5. Validator mining loop ──────────────────────────────────
  if (config.isValidator) {
    console.log(
      `[${config.nodeName}] Mining loop started ` +
      `(interval: ${config.validatorIntervalMs / 1000}s).`,
    );

    setInterval(async () => {
      // Skip this cycle if there is nothing to seal.
      if (txPool.size === 0) return;

      console.log(`[${config.nodeName}] Mining — ${txPool.size} pending vote(s).`);

      try {
        // Drain the pool BEFORE building the block so votes that arrive
        // during the async DB write don't get dropped on the next cycle.
        const votes = txPool.getTransactions();
        txPool.clearPool();

        const newBlock = blockchain.addBlock(votes);

        // Persist the block to MongoDB.
        await BlockModel.create(newBlock.toJSON());
        console.log(
          `[${config.nodeName}] Block ${newBlock.index} mined and persisted ` +
          `(${votes.length} vote(s), hash: ${newBlock.hash.slice(0, 12)}…).`,
        );

        // Broadcast the new block to all peers via RabbitMQ.
        messageBus.publishBlock(newBlock);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${config.nodeName}] Mining failed: ${msg}`);
      }
    }, config.validatorIntervalMs);
  } else {
    console.log(`[${config.nodeName}] Running as GATEWAY — mining loop not started.`);
  }
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
