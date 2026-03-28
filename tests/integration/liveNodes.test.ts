import { ethers } from "ethers";

const BASE_URL = process.env["LIVE_NODE_URL"] ?? "http://localhost:3000";

describe("Live node integration", () => {
  test("gateway health endpoint responds", async () => {
    const response = await fetch(`${BASE_URL}/`);
    expect(response.status).toBe(200);

    const body = await response.json() as { status: string; node: string };
    expect(body.status).toBe("Node is alive");
    expect(typeof body.node).toBe("string");
  });

  test("peers endpoint exposes peer metrics", async () => {
    const response = await fetch(`${BASE_URL}/peers`);
    expect(response.status).toBe(200);

    const body = await response.json() as { connectedPeers: number; configuredPeers: unknown[] };
    expect(typeof body.connectedPeers).toBe("number");
    expect(Array.isArray(body.configuredPeers)).toBe(true);
  });

  test("valid signed vote is accepted and duplicate is rejected", async () => {
    const wallet = ethers.Wallet.createRandom();

    const voteData = {
      senderPublicKey: wallet.address,
      candidateId: "Alice",
      electionId: "election-2026",
      timestamp: new Date().toISOString(),
    };

    const signature = await wallet.signMessage(JSON.stringify(voteData));
    const votePayload = { ...voteData, signature };

    const firstResponse = await fetch(`${BASE_URL}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(votePayload),
    });

    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json() as { message: string };
    expect(firstBody.message).toBe("Vote added to pending pool");

    const secondResponse = await fetch(`${BASE_URL}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(votePayload),
    });

    expect(secondResponse.status).toBe(400);
    const secondBody = await secondResponse.json() as { error: string };
    expect(secondBody.error).toBe("User already voted");
  });

  test("forged signature is rejected", async () => {
    const claimedWallet = ethers.Wallet.createRandom();
    const attackerWallet = ethers.Wallet.createRandom();

    const voteData = {
      senderPublicKey: claimedWallet.address,
      candidateId: "Bob",
      electionId: "election-2026",
      timestamp: new Date().toISOString(),
    };

    const forgedSignature = await attackerWallet.signMessage(JSON.stringify(voteData));
    const forgedPayload = { ...voteData, signature: forgedSignature };

    const response = await fetch(`${BASE_URL}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(forgedPayload),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("Invalid signature");
  });
});
