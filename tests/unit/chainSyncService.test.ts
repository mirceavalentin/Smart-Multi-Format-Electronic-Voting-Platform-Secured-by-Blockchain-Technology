/**
 * Unit tests for ChainSyncService.
 *
 * These tests mock the MongoDB model and the two callbacks (onPublishBlock,
 * onRequestFullChain) so no live broker or database is needed. They verify
 * the sync decision tree: append single block, request full chain when there
 * is a gap, and replace the local chain when a longer valid one arrives.
 */

import { ChainSyncService } from "../../src/network/chainSyncService.js";
import { Blockchain }        from "../../src/core/Blockchain.js";
import { TransactionPool }   from "../../src/core/TransactionPool.js";
import { Block }             from "../../src/core/Block.js";

// Mock MongoDB so tests don't need a live database.
jest.mock("../../src/db/models.js", () => ({
  BlockModel: {
    updateOne:   jest.fn().mockResolvedValue({}),
    deleteMany:  jest.fn().mockResolvedValue({}),
    insertMany:  jest.fn().mockResolvedValue([]),
  },
}));

import { BlockModel } from "../../src/db/models.js";

// ─── Helpers ─────────────────────────────────────────────────────

/** Build a ChainSyncService with fresh mocks each time. */
function makeService(
  blockchain: Blockchain,
  txPool:     TransactionPool,
  onRequestFullChain: () => Promise<import("../../src/models/block.js").Block[][]> = jest.fn().mockResolvedValue([]),
) {
  const onPublishBlock = jest.fn();
  const service = new ChainSyncService(
    blockchain,
    txPool,
    "unit-node",
    onPublishBlock,
    onRequestFullChain,
  );
  return { service, onPublishBlock };
}

// ─── Tests ───────────────────────────────────────────────────────

describe("ChainSyncService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("appends a valid block that extends the local tip", async () => {
    const blockchain = new Blockchain();
    const txPool     = new TransactionPool();
    const { service, onPublishBlock } = makeService(blockchain, txPool);

    const tip      = blockchain.getLatestBlock();
    const newBlock = new Block(tip.index + 1, new Date().toISOString(), [], tip.hash, 0);

    service.handleReceivedBlock(JSON.stringify(newBlock));

    // Give async DB persist time to settle.
    await Promise.resolve();

    expect(blockchain.chain.length).toBe(2);
    expect((BlockModel.updateOne as jest.Mock)).toHaveBeenCalledTimes(1);
    // onPublishBlock is called to forward the block to peers.
    expect(onPublishBlock).toHaveBeenCalledTimes(1);
  });

  test("ignores a stale block (index <= local tip)", () => {
    const blockchain = new Blockchain();
    const txPool     = new TransactionPool();
    const { service, onPublishBlock } = makeService(blockchain, txPool);

    // Genesis is index 0 — sending it again should be ignored.
    const genesis = blockchain.getLatestBlock();
    service.handleReceivedBlock(JSON.stringify(genesis));

    expect(blockchain.chain.length).toBe(1);
    expect(onPublishBlock).not.toHaveBeenCalled();
  });

  test("rejects a block with a tampered hash", async () => {
    const blockchain = new Blockchain();
    const txPool     = new TransactionPool();
    const { service, onPublishBlock } = makeService(blockchain, txPool);

    const tip      = blockchain.getLatestBlock();
    const newBlock = new Block(tip.index + 1, new Date().toISOString(), [], tip.hash, 0);

    // Tamper with the serialised hash before sending.
    const tampered = { ...newBlock.toJSON(), hash: "000000000000" };
    service.handleReceivedBlock(JSON.stringify(tampered));

    await Promise.resolve();

    expect(blockchain.chain.length).toBe(1); // not appended
    expect(onPublishBlock).not.toHaveBeenCalled();
  });

  test("calls onRequestFullChain when there is a gap in the chain", async () => {
    const blockchain = new Blockchain();
    const txPool     = new TransactionPool();

    const onRequestFullChain = jest.fn().mockResolvedValue([]);
    const { service } = makeService(blockchain, txPool, onRequestFullChain);

    // Build a block at index 5, which cannot be appended to a chain at index 0.
    const gapBlock = new Block(5, new Date().toISOString(), [], "wrong-prev-hash", 0);
    service.handleReceivedBlock(JSON.stringify(gapBlock));

    // Let the async sync fire.
    await new Promise((r) => setTimeout(r, 50));

    expect(onRequestFullChain).toHaveBeenCalledTimes(1);
    expect(blockchain.chain.length).toBe(1); // still at genesis
  });

  test("replaces local chain when a longer valid chain arrives via full sync", async () => {
    const blockchain = new Blockchain();
    const txPool     = new TransactionPool();

    // Build a 3-block candidate chain.
    const chain: Block[] = [blockchain.chain[0]!];
    chain.push(new Block(1, new Date().toISOString(), [], chain[0]!.hash, 0));
    chain.push(new Block(2, new Date().toISOString(), [], chain[1]!.hash, 0));

    const onRequestFullChain = jest.fn().mockResolvedValue([chain]);
    const { service } = makeService(blockchain, txPool, onRequestFullChain);

    // Trigger the slow path (gap block).
    const gapBlock = new Block(2, new Date().toISOString(), [], "wrong-prev", 0);
    service.handleReceivedBlock(JSON.stringify(gapBlock));

    await new Promise((r) => setTimeout(r, 50));

    expect(blockchain.chain.length).toBe(3);
    expect((BlockModel.deleteMany  as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((BlockModel.insertMany  as jest.Mock)).toHaveBeenCalledTimes(1);
  });
});
