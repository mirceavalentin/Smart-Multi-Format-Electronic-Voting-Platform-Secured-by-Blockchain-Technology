/**
 * ============================================================================
 *  network/chainSyncService.ts — Blockchain sync + persistence module.
 * ============================================================================
 *
 * This module isolates the heavy chain reconciliation logic from the socket
 * orchestration layer (`p2p.ts`). It is responsible for:
 *
 *   1. Interpreting RESPONSE_BLOCKCHAIN payloads.
 *   2. Deciding append vs full-chain replacement.
 *   3. Validating candidate chains.
 *   4. Persisting accepted blocks to MongoDB.
 *   5. Triggering follow-up gossip messages when needed.
 *
 * Keeping this logic separate makes P2P orchestration easier to reason about,
 * easier to test, and easier to defend as clean separation of concerns.
 * ============================================================================
 */

import type { Block as IBlock } from "../models/block.js";
import { Block } from "../core/Block.js";
import { Blockchain } from "../core/Blockchain.js";
import { TransactionPool } from "../core/TransactionPool.js";
import { BlockModel } from "../db/models.js";
import {
  queryAllMsg,
  responseBlockchainMsg,
  type P2PMessage,
} from "./messageTypes.js";

export class ChainSyncService {
  private blockchain: Blockchain;
  private txPool: TransactionPool;
  private nodeName: string;
  private onBroadcast: (message: P2PMessage) => void;

  constructor(
    blockchain: Blockchain,
    txPool: TransactionPool,
    nodeName: string,
    onBroadcast: (message: P2PMessage) => void,
  ) {
    this.blockchain = blockchain;
    this.txPool = txPool;
    this.nodeName = nodeName;
    this.onBroadcast = onBroadcast;
  }

  /** Entry point for handling RESPONSE_BLOCKCHAIN data payloads. */
  public handleBlockchainResponse(data: string): void {
    let receivedBlocks: IBlock[];
    try {
      receivedBlocks = JSON.parse(data) as IBlock[];
    } catch {
      console.warn(`[${this.nodeName}] [P2P] Invalid blockchain data received, ignoring.`);
      return;
    }

    if (receivedBlocks.length === 0) {
      console.log(`[${this.nodeName}] [P2P] Received empty blockchain response, ignoring.`);
      return;
    }

    receivedBlocks.sort((a, b) => a.index - b.index);

    const latestReceived = receivedBlocks[receivedBlocks.length - 1]!;
    const latestLocal = this.blockchain.getLatestBlock();

    if (latestReceived.index <= latestLocal.index) {
      console.log(
        `[${this.nodeName}] [P2P] Peer chain (height ${latestReceived.index}) ` +
        `<= local chain (height ${latestLocal.index}). No action needed.`,
      );
      return;
    }

    console.log(
      `[${this.nodeName}] [P2P] Peer has a longer chain ` +
      `(peer height: ${latestReceived.index}, local height: ${latestLocal.index}).`,
    );

    if (latestLocal.hash === latestReceived.previousHash) {
      this.appendSingleBlock(latestReceived);
      return;
    }

    if (receivedBlocks.length === 1) {
      console.log(`[${this.nodeName}] [P2P] Single block received but can't append. Requesting full chain...`);
      this.onBroadcast(queryAllMsg());
      return;
    }

    console.log(`[${this.nodeName}] [P2P] Received full chain (${receivedBlocks.length} blocks). Evaluating...`);
    this.tryReplaceChain(receivedBlocks);
  }

  private appendSingleBlock(receivedBlock: IBlock): void {
    console.log(`[${this.nodeName}] [P2P] Appending single new block (index ${receivedBlock.index}).`);

    const newBlock = new Block(
      receivedBlock.index,
      receivedBlock.timestamp,
      receivedBlock.transactions,
      receivedBlock.previousHash,
      receivedBlock.nonce,
    );

    if (newBlock.hash !== receivedBlock.hash) {
      console.warn(`[${this.nodeName}] [P2P] Block hash mismatch - rejecting.`);
      return;
    }

    this.blockchain.chain.push(newBlock);

    // Remove mined transactions from our local pool to prevent duplicate mining
    const minedSigs = new Set<string>();
    for (const tx of newBlock.transactions) {
      minedSigs.add(tx.signature);
    }
    this.txPool.removeMinedTransactions(minedSigs);

    this.persistBlock(newBlock).catch((err) => {
      console.error(`[${this.nodeName}] [P2P] Failed to persist received block:`, err);
    });

    this.onBroadcast(responseBlockchainMsg([newBlock]));
  }

  private tryReplaceChain(receivedBlocks: IBlock[]): void {
    const candidateChain: Block[] = receivedBlocks.map(
      (b) => new Block(b.index, b.timestamp, b.transactions, b.previousHash, b.nonce),
    );

    for (let i = 0; i < candidateChain.length; i++) {
      if (candidateChain[i]!.hash !== receivedBlocks[i]!.hash) {
        console.warn(`[${this.nodeName}] [P2P] Hash mismatch at block ${i}. Rejecting chain.`);
        return;
      }
    }

    const tempBlockchain = new Blockchain();
    tempBlockchain.chain = candidateChain;

    if (!tempBlockchain.isChainValid()) {
      console.warn(`[${this.nodeName}] [P2P] Received chain is invalid. Rejecting.`);
      return;
    }

    if (candidateChain.length <= this.blockchain.chain.length) {
      console.log(`[${this.nodeName}] [P2P] Received chain is not longer. Keeping local chain.`);
      return;
    }

    console.log(
      `[${this.nodeName}] [P2P] Replacing local chain ` +
      `(${this.blockchain.chain.length} blocks -> ${candidateChain.length} blocks).`,
    );

    this.blockchain.chain = candidateChain;

    // After replacing the full chain, clear pool of any already-mined transactions
    const allMinedSigs = new Set<string>();
    for (const block of candidateChain) {
      for (const tx of block.transactions) {
        allMinedSigs.add(tx.signature);
      }
    }
    this.txPool.removeMinedTransactions(allMinedSigs);

    this.persistFullChain(candidateChain).catch((err) => {
      console.error(`[${this.nodeName}] [P2P] Failed to persist replaced chain:`, err);
    });

    this.onBroadcast(responseBlockchainMsg([this.blockchain.getLatestBlock()]));
  }

  private async persistBlock(block: Block): Promise<void> {
    await BlockModel.updateOne(
      { index: block.index },
      {
        $set: {
          index: block.index,
          timestamp: block.timestamp,
          transactions: block.transactions,
          previousHash: block.previousHash,
          hash: block.hash,
          nonce: block.nonce,
        },
      },
      { upsert: true },
    );
    console.log(`[${this.nodeName}] [P2P] Block ${block.index} persisted to MongoDB.`);
  }

  private async persistFullChain(chain: Block[]): Promise<void> {
    await BlockModel.deleteMany({});
    const docs = chain.map((b) => ({
      index: b.index,
      timestamp: b.timestamp,
      transactions: b.transactions,
      previousHash: b.previousHash,
      hash: b.hash,
      nonce: b.nonce,
    }));
    await BlockModel.insertMany(docs);
    console.log(`[${this.nodeName}] [P2P] Full chain (${chain.length} blocks) persisted to MongoDB.`);
  }
}
