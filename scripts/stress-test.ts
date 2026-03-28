/**
 * ============================================================================
 *  stress-test.ts — Automated vote submission for thesis live demo.
 * ============================================================================
 *
 * PURPOSE:
 *
 * This standalone script simulates 10 independent voters, each with a
 * unique Ethereum wallet. It demonstrates:
 *
 *   1. **ECDSA signing** — each vote is signed with the voter's private key
 *      using `wallet.signMessage()`, producing a 65-byte secp256k1 signature.
 *
 *   2. **Signature verification** — the server recovers the signer's address
 *      using `ethers.verifyMessage()` and rejects forged or mismatched votes.
 *
 *   3. **Double-vote prevention** — the server's State class tracks which
 *      addresses have already voted and returns HTTP 400 for duplicates.
 *
 * USAGE:
 *
 *   # Make sure containers are running:
 *   podman-compose up -d --build
 *
 *   # Run the stress test (from the project root):
 *   npx ts-node scripts/stress-test.ts
 *
 *   # Or with Node.js directly after building:
 *   npx tsc -p tsconfig.stress.json && node dist-scripts/stress-test.js
 *
 * CRYPTOGRAPHIC WALKTHROUGH (for academic defence):
 *
 * Each iteration of the loop does the following:
 *
 *   1. `ethers.Wallet.createRandom()` generates a random 256-bit private key
 *      and derives the corresponding secp256k1 public key and Ethereum address.
 *      The private key never leaves this script — it simulates the voter's
 *      client-side environment (e.g. MetaMask).
 *
 *   2. We construct a **canonical vote payload** — a deterministic JSON
 *      string containing the vote data (everything EXCEPT the signature).
 *      This is the message that gets signed.
 *
 *   3. `wallet.signMessage(canonicalPayload)` performs EIP-191 personal signing:
 *        a. Prefixes the message: "\x19Ethereum Signed Message:\n" + length + message
 *        b. Hashes the prefixed message with Keccak-256.
 *        c. Signs the hash using ECDSA with the wallet's private key.
 *        d. Returns the signature as a hex string (r + s + v, 65 bytes).
 *
 *      The EIP-191 prefix is critical — it prevents the signed message from
 *      being replayable as a raw Ethereum transaction. MetaMask applies the
 *      same prefix when users click "Sign".
 *
 *   4. We POST the complete vote object (payload + signature) to the Gateway.
 *      The server calls `ethers.verifyMessage(canonicalPayload, signature)`,
 *      which uses **ECDSA public-key recovery** (ecrecover) to derive the
 *      signer's address WITHOUT needing the private key. This is the
 *      mathematical property that makes blockchain authentication possible:
 *      anyone can verify, only the key holder can sign.
 *
 *   5. The server checks:
 *        - Recovered address matches the claimed `senderPublicKey` → authentic.
 *        - Address has not voted before → not a duplicate.
 *      If both pass, the vote enters the mempool and is gossiped to Validators.
 * ============================================================================
 */

import { ethers } from "ethers";

// ─── Configuration ──────────────────────────────────────────────────
const GATEWAY_URL = "http://localhost:3000/vote";
const NUM_VOTERS = 10;
const DELAY_MS = 100; // milliseconds between requests

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Simple delay helper. Returns a Promise that resolves after `ms` milliseconds.
 * Used to throttle requests and simulate real network traffic patterns.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a single vote to the Gateway.
 *
 * Uses the native `fetch` API (available in Node.js ≥ 18) to avoid
 * external HTTP library dependencies.
 */
async function submitVote(votePayload: Record<string, string>): Promise<void> {
  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(votePayload),
  });

  const body = await response.json();
  const status = response.status;
  const address = votePayload["senderPublicKey"] ?? "unknown";

  if (status === 200) {
    console.log(`  ✔ [${status}] Vote accepted from ${address}`);
  } else {
    console.warn(`  ✘ [${status}] Rejected: ${JSON.stringify(body)}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Blockchain Voting — Stress Test (ECDSA + Double-Vote)");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Target:  ${GATEWAY_URL}`);
  console.log(`  Voters:  ${NUM_VOTERS}`);
  console.log(`  Delay:   ${DELAY_MS}ms between requests`);
  console.log("═══════════════════════════════════════════════════════\n");

  // ── Phase 1: Submit 10 unique votes ────────────────────────────────

  console.log("Phase 1 — Submitting unique votes...\n");

  const wallets: ethers.HDNodeWallet[] = [];
  const candidates = ["Alice", "Bob", "Charlie"];

  for (let i = 0; i < NUM_VOTERS; i++) {
    /*
     * Generate a random Ethereum wallet. In the real system, the voter
     * would use MetaMask or a hardware wallet — here we simulate that
     * by creating ephemeral key pairs.
     *
     * ethers.Wallet.createRandom() internally:
     *   1. Generates 16 bytes of cryptographic randomness (CSPRNG).
     *   2. Derives a BIP-39 mnemonic phrase.
     *   3. Uses BIP-32 HD derivation to produce a secp256k1 key pair.
     *   4. Computes the Ethereum address: keccak256(pubkey)[12..31].
     */
    const wallet = ethers.Wallet.createRandom();
    wallets.push(wallet);

    // Build the canonical vote payload (all fields except signature).
    const voteData = {
      senderPublicKey: wallet.address,
      candidateId: candidates[i % candidates.length]!,
      electionId: "election-2026",
      timestamp: new Date().toISOString(),
    };

    /*
     * Sign the canonical JSON-stringified payload.
     *
     * wallet.signMessage() applies EIP-191 personal sign:
     *   hash = keccak256("\x19Ethereum Signed Message:\n" + len + message)
     *   signature = ECDSA_sign(hash, privateKey)
     *
     * The returned hex string contains r (32 bytes) + s (32 bytes) + v (1 byte).
     * v encodes the recovery parameter, allowing ecrecover on the server
     * to determine which of the two possible public keys is the correct one.
     */
    const canonicalPayload = JSON.stringify(voteData);
    const signature = await wallet.signMessage(canonicalPayload);

    // Combine payload + signature into the full vote object.
    const fullVote = { ...voteData, signature };

    console.log(`[Voter ${i + 1}/${NUM_VOTERS}] Address: ${wallet.address}`);
    await submitVote(fullVote);

    // Throttle to simulate realistic traffic.
    if (i < NUM_VOTERS - 1) {
      await sleep(DELAY_MS);
    }
  }

  // ── Phase 2: Attempt double-votes (should all fail with 400) ───────

  console.log("\n─────────────────────────────────────────────────────");
  console.log("Phase 2 — Attempting double-votes (expect 400 errors)...\n");

  for (let i = 0; i < Math.min(3, wallets.length); i++) {
    const wallet = wallets[i]!;

    // Re-sign a new vote with the same wallet (different candidate).
    const doubleVoteData = {
      senderPublicKey: wallet.address,
      candidateId: "Mallory", // different candidate — doesn't matter, same address
      electionId: "election-2026",
      timestamp: new Date().toISOString(),
    };

    const canonicalPayload = JSON.stringify(doubleVoteData);
    const signature = await wallet.signMessage(canonicalPayload);
    const fullVote = { ...doubleVoteData, signature };

    console.log(`[Double-vote ${i + 1}] Address: ${wallet.address}`);
    await submitVote(fullVote);
    await sleep(DELAY_MS);
  }

  // ── Phase 3: Attempt a forged signature (should fail with 400) ─────

  console.log("\n─────────────────────────────────────────────────────");
  console.log("Phase 3 — Attempting forged signature (expect 400)...\n");

  const legitimateWallet = ethers.Wallet.createRandom();
  const attackerWallet = ethers.Wallet.createRandom();

  // Attacker signs the payload, but claims to be the legitimate wallet.
  const forgedVoteData = {
    senderPublicKey: legitimateWallet.address, // ← claims to be someone else
    candidateId: "Alice",
    electionId: "election-2026",
    timestamp: new Date().toISOString(),
  };

  const forgedPayload = JSON.stringify(forgedVoteData);
  const forgedSignature = await attackerWallet.signMessage(forgedPayload); // ← signed by attacker

  console.log(`[Forged] Claimed address: ${legitimateWallet.address}`);
  console.log(`[Forged] Actual signer:   ${attackerWallet.address}`);
  await submitVote({ ...forgedVoteData, signature: forgedSignature });

  // ── Summary ────────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Stress test complete!");
  console.log("  Check the Gateway logs and GET /blocks to verify.");
  console.log("═══════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Stress test failed:", err);
  process.exit(1);
});
