import { ChainSyncService } from "../../src/network/chainSyncService.js";
import { Blockchain } from "../../src/core/Blockchain.js";
import { Block } from "../../src/core/Block.js";
import { MessageType } from "../../src/network/messageTypes.js";

jest.mock("../../src/db/models.js", () => ({
  BlockModel: {
    updateOne: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({}),
    insertMany: jest.fn().mockResolvedValue([]),
  },
}));

import { BlockModel } from "../../src/db/models.js";

describe("ChainSyncService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("appends one valid next block and broadcasts latest tip", async () => {
    const blockchain = new Blockchain();
    const onBroadcast = jest.fn();
    const service = new ChainSyncService(blockchain, "unit-node", onBroadcast);

    const latest = blockchain.getLatestBlock();
    const nextBlock = new Block(
      latest.index + 1,
      new Date().toISOString(),
      [],
      latest.hash,
      0,
    );

    service.handleBlockchainResponse(JSON.stringify([nextBlock]));
    await Promise.resolve();

    expect(blockchain.chain.length).toBe(2);
    expect((BlockModel.updateOne as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(onBroadcast).toHaveBeenCalledTimes(1);
    expect(onBroadcast.mock.calls[0][0].type).toBe(MessageType.RESPONSE_BLOCKCHAIN);
  });

  test("requests full chain when single block does not extend local tip", () => {
    const blockchain = new Blockchain();
    const onBroadcast = jest.fn();
    const service = new ChainSyncService(blockchain, "unit-node", onBroadcast);

    const incompatibleBlock = new Block(
      blockchain.getLatestBlock().index + 5,
      new Date().toISOString(),
      [],
      "wrong-previous-hash",
      0,
    );

    service.handleBlockchainResponse(JSON.stringify([incompatibleBlock]));

    expect(onBroadcast).toHaveBeenCalledTimes(1);
    expect(onBroadcast.mock.calls[0][0].type).toBe(MessageType.QUERY_ALL);
    expect(blockchain.chain.length).toBe(1);
  });
});
