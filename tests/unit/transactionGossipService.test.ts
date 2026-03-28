import { TransactionGossipService } from "../../src/network/transactionGossipService.js";

describe("TransactionGossipService", () => {
  test("adds parsed vote to the pool", () => {
    const addTransaction = jest.fn();
    const txPool = {
      addTransaction,
      size: 1,
    };

    const service = new TransactionGossipService(txPool as any, "unit-node");

    const vote = {
      senderPublicKey: "0xabc",
      candidateId: "Alice",
      electionId: "election-2026",
      timestamp: "2026-01-01T00:00:00.000Z",
      signature: "0xsig",
    };

    service.handleBroadcastTransaction(JSON.stringify(vote));

    expect(addTransaction).toHaveBeenCalledTimes(1);
    expect(addTransaction).toHaveBeenCalledWith(vote);
  });

  test("ignores invalid JSON payload", () => {
    const addTransaction = jest.fn();
    const txPool = {
      addTransaction,
      size: 0,
    };

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const service = new TransactionGossipService(txPool as any, "unit-node");
    service.handleBroadcastTransaction("not-json");

    expect(addTransaction).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
