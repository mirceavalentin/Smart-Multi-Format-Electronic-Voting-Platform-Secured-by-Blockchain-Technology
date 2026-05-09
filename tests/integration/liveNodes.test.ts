/**
 * Integration tests for the live Gateway node.
 *
 * These tests require the full stack to be running:
 *   podman-compose up --build
 *
 * Override the target URL with the LIVE_NODE_URL environment variable:
 *   LIVE_NODE_URL=http://localhost:3000 npm run test:integration
 *
 * The tests assume an election with candidateId "Alice" is either already
 * active, or that an election can be created at the start of the test run.
 * They use fresh random Ethereum wallets for each test so they don't
 * interfere with each other's double-vote state.
 */

import { ethers } from "ethers";

const BASE_URL = process.env["LIVE_NODE_URL"] ?? "http://localhost:3000";

// ─── Helpers ─────────────────────────────────────────────────────

/** Sign a canonical vote payload and return the full vote object. */
async function buildVote(
  wallet: ethers.Wallet,
  candidateId: string,
  electionId: string,
) {
  const voteData = {
    senderPublicKey: wallet.address,
    candidateId,
    electionId,
    timestamp: new Date().toISOString(),
  };
  const signature = await wallet.signMessage(JSON.stringify(voteData));
  return { ...voteData, signature };
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Live node integration", () => {
  test("GET /api/health responds with node-alive status", async () => {
    const res  = await fetch(`${BASE_URL}/api/health`);
    expect(res.status).toBe(200);

    const body = await res.json() as { status: string; node: string };
    expect(body.status).toBe("Node is alive");
    expect(typeof body.node).toBe("string");
  });

  test("GET /api/peers reports message bus status", async () => {
    const res  = await fetch(`${BASE_URL}/api/peers`);
    expect(res.status).toBe(200);

    const body = await res.json() as { messageBus: string; brokerUrl: string };
    expect(body.messageBus).toBe("connected");
    expect(typeof body.brokerUrl).toBe("string");
  });

  test("GET /api/blocks returns a valid chain", async () => {
    const res  = await fetch(`${BASE_URL}/api/blocks`);
    expect(res.status).toBe(200);

    const body = await res.json() as { isValid: boolean; length: number };
    expect(body.isValid).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1); // at least genesis
  });

  test("valid signed vote is accepted and duplicate is rejected", async () => {
    // First, make sure there is an active election to vote in.
    const statusRes = await fetch(`${BASE_URL}/api/election/status`);
    const status = await statusRes.json() as { isActive: boolean; electionId?: string; candidates?: string[]; whitelist?: string[] };

    let electionId: string;
    let candidateId: string;
    let wallet = ethers.Wallet.createRandom();

    if (!status.isActive) {
      // Create a short election for this test run.
      const createRes = await fetch(`${BASE_URL}/api/election`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          candidates:      ["Alice", "Bob"],
          whitelist:       [wallet.address],
          durationSeconds: 120,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json() as { election: { electionId: string } };
      electionId  = created.election.electionId;
      candidateId = "Alice";
    } else {
      electionId  = status.electionId!;
      candidateId = status.candidates![0]!;
      // Re-create wallet with an address in the whitelist if possible;
      // in automated CI this means the whitelist must include the generated address.
      wallet = ethers.Wallet.createRandom();

      // Add the fresh wallet to the election whitelist by creating a new election.
      const createRes = await fetch(`${BASE_URL}/api/election`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          candidates:      status.candidates,
          whitelist:       [wallet.address],
          durationSeconds: 120,
        }),
      });
      const created = await createRes.json() as { election: { electionId: string } };
      electionId  = created.election.electionId;
    }

    const vote = await buildVote(wallet, candidateId, electionId);

    // First vote — should be accepted.
    const firstRes  = await fetch(`${BASE_URL}/api/vote`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(vote),
    });
    expect(firstRes.status).toBe(200);
    const firstBody = await firstRes.json() as { message: string };
    expect(firstBody.message).toBe("Vote accepted.");

    // Second identical vote — should be rejected.
    const secondRes  = await fetch(`${BASE_URL}/api/vote`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(vote),
    });
    expect(secondRes.status).toBe(400);
    const secondBody = await secondRes.json() as { error: string };
    expect(secondBody.error).toBe("This address has already voted.");
  });

  test("forged signature is rejected", async () => {
    const statusRes  = await fetch(`${BASE_URL}/api/election/status`);
    const status     = await statusRes.json() as { isActive: boolean; electionId?: string; candidates?: string[] };

    if (!status.isActive) {
      console.warn("Skipping forged-signature test — no active election.");
      return;
    }

    const claimedWallet  = ethers.Wallet.createRandom();
    const attackerWallet = ethers.Wallet.createRandom();

    const voteData = {
      senderPublicKey: claimedWallet.address,
      candidateId:     status.candidates![0]!,
      electionId:      status.electionId!,
      timestamp:       new Date().toISOString(),
    };

    // Attacker signs with THEIR key but claims to be claimedWallet.
    const forgedSignature = await attackerWallet.signMessage(JSON.stringify(voteData));
    const forgedPayload   = { ...voteData, signature: forgedSignature };

    const res  = await fetch(`${BASE_URL}/api/vote`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(forgedPayload),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Invalid signature.");
  });

  // ─── Multi-format ─────────────────────────────────────────────────
  // The next three tests exercise the three election formats end-to-end:
  // create election → cast valid vote → confirm acceptance.

  test("multiple-choice: pipe-delimited approvals are accepted", async () => {
    const wallet = ethers.Wallet.createRandom();

    const createRes = await fetch(`${BASE_URL}/api/election`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        type:            "multiple-choice",
        candidates:      ["Alice", "Bob", "Charlie"],
        whitelist:       [wallet.address],
        durationSeconds: 120,
        maxSelections:   2,
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { election: { electionId: string; type: string; maxSelections: number } };
    expect(created.election.type).toBe("multiple-choice");
    expect(created.election.maxSelections).toBe(2);

    const vote = await buildVote(wallet, "Alice|Bob", created.election.electionId);
    const voteRes = await fetch(`${BASE_URL}/api/vote`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(vote),
    });
    expect(voteRes.status).toBe(200);
    const voteBody = await voteRes.json() as { message: string };
    expect(voteBody.message).toBe("Vote accepted.");
  });

  test("multiple-choice: too many selections are rejected", async () => {
    const wallet = ethers.Wallet.createRandom();

    const createRes = await fetch(`${BASE_URL}/api/election`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        type:            "multiple-choice",
        candidates:      ["Alice", "Bob", "Charlie"],
        whitelist:       [wallet.address],
        durationSeconds: 120,
        maxSelections:   2,
      }),
    });
    const created = await createRes.json() as { election: { electionId: string } };

    const vote = await buildVote(wallet, "Alice|Bob|Charlie", created.election.electionId);
    const res  = await fetch(`${BASE_URL}/api/vote`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(vote),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/Too many selections/);
  });

  test("yes-no: 'yes' answer is accepted, anything else is rejected", async () => {
    const wallet = ethers.Wallet.createRandom();

    const createRes = await fetch(`${BASE_URL}/api/election`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        type:            "yes-no",
        whitelist:       [wallet.address],
        durationSeconds: 120,
        question:        "Should we adopt the new charter?",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { election: { electionId: string; type: string; question: string; candidates: string[] } };
    expect(created.election.type).toBe("yes-no");
    expect(created.election.candidates).toEqual(["yes", "no"]);

    // Valid "yes" answer.
    const goodVote = await buildVote(wallet, "yes", created.election.electionId);
    const goodRes  = await fetch(`${BASE_URL}/api/vote`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(goodVote),
    });
    expect(goodRes.status).toBe(200);

    // Need a fresh wallet for the next vote (double-vote protection).
    const wallet2 = ethers.Wallet.createRandom();

    // Re-create the election with wallet2 in the whitelist.
    const recreateRes = await fetch(`${BASE_URL}/api/election`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        type:            "yes-no",
        whitelist:       [wallet2.address],
        durationSeconds: 120,
        question:        "Same question?",
      }),
    });
    const recreated = await recreateRes.json() as { election: { electionId: string } };

    // Invalid "maybe" answer.
    const badVote = await buildVote(wallet2, "maybe", recreated.election.electionId);
    const badRes  = await fetch(`${BASE_URL}/api/vote`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(badVote),
    });
    expect(badRes.status).toBe(400);
    const badBody = await badRes.json() as { error: string };
    expect(badBody.error).toMatch(/Invalid answer/);
  });
});
