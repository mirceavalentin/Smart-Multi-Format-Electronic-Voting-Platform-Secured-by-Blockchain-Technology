# CLAUDE.md — Blockchain Voting Platform

## What this is
Thesis prototype: a Proof-of-Authority blockchain voting system. Node.js/TypeScript. 4-node private network (1 Gateway + 3 Validators), each with its own MongoDB. Inter-node communication via a 3-node RabbitMQ HA cluster (replaced the original WebSocket P2P layer). Designed for thesis defence demos — full election lifecycle in ~60s, infinitely repeatable without container restarts.

## Stack
- **Runtime**: Node.js ≥18, TypeScript 5
- **HTTP**: Express 4 (all routes inline in `src/server.ts`)
- **Messaging**: `amqplib` → RabbitMQ 3.12 (fanout exchanges, per-node queues)
- **DB**: MongoDB via Mongoose 8
- **Crypto**: Node.js `crypto` (SHA-256 blocks), `ethers` v6 (ECDSA vote signatures)
- **Container**: Docker/Podman + `podman-compose.yml`

## Commands
```bash
npm run dev          # ts-node (no build needed, needs local Mongo + RabbitMQ)
npm run build        # tsc → dist/
npm start            # node dist/server.js
npm test             # all tests (--runInBand required)
npm run test:unit    # unit only (no live containers)
npm run test:integration  # needs running containers at localhost:3000
podman-compose up --build   # start all 11 containers
podman-compose down -v      # stop + wipe volumes
```

## Architecture

### Node roles (env vars)
| Role | `IS_VALIDATOR` | Mines blocks | External port |
|------|---------------|-------------|--------------|
| Gateway | `false` | No | 3000 |
| Validator 1–3 | `true` | Yes (every 15s) | none |

### All env vars (parsed in `src/utils/config.ts`)
- `NODE_NAME` — human-readable name, used in logs and RabbitMQ queue names
- `PORT` / `HTTP_PORT` — HTTP port (default 3000)
- `MONGO_URI` — MongoDB connection string
- `RABBITMQ_URL` — AMQP broker URL (default `amqp://admin:admin@localhost:5672`)
- `IS_VALIDATOR` — `"true"` | `"false"`
- `VALIDATOR_INTERVAL_MS` — mining cycle interval (default 15000ms)

### RabbitMQ exchanges (all fanout)
| Exchange | Publisher | Subscribers |
|---|---|---|
| `voting.votes` | Gateway | All Validators |
| `voting.election` | Gateway | All nodes |
| `voting.blocks` | Each Validator | All other nodes |
| `voting.chain-req` | Any node (gap in chain) | All nodes (respond with full chain) |

Each node has per-node durable queues (`votes.{nodeName}`, `blocks.{nodeName}`, etc.) bound to the exchanges. The chain-response queue (`chain-res.{nodeName}`) is exclusive and non-durable.

## Source map
```
src/
  server.ts              — entry point: all Express routes + boot + auto-wipe timer
  utils/
    config.ts            — loadConfig(): parses all env vars into NodeConfig struct
    logger.ts            — createLogger(nodeName): structured console wrapper
  core/
    Block.ts             — Block class: SHA-256 hash, toJSON(), calculateHash()
    Blockchain.ts        — chain: addBlock(), isChainValid(), resetToGenesis()
    Election.ts          — in-memory election config: activate(), deactivate(), isVoteValid()
    State.ts             — double-vote tracker: hasVoted(), markVoted(), clear()
    TransactionPool.ts   — mempool: addTransaction(), clearPool(), removeMinedTransactions()
    consensus.ts         — stub (empty, planned)
  network/
    messageBus.ts        — RabbitMQ client: connect(), publish*(), subscribe*(), requestFullChain()
    messageTypes.ts      — typed message interfaces: VoteMessage, BlockMessage, etc.
    chainSyncService.ts  — append vs replace logic when blocks arrive from RabbitMQ
    transactionGossipService.ts — parses vote payloads → txPool.addTransaction()
    p2p.ts               — DEPRECATED stub (replaced by messageBus.ts, safe to delete)
  db/
    connection.ts        — connectToDatabase(uri) with retry
    models.ts            — BlockModel (Mongoose schema)
  models/
    block.ts             — IBlock interface
    vote.ts              — Vote interface
    index.ts             — re-exports
public/
  index.html             — voter UI (MetaMask required)
  admin.html             — admin panel (create election, inspect chain)
tests/
  unit/
    chainSyncService.test.ts      — mocks DB + callbacks, tests sync decisions
    transactionGossipService.test.ts
  integration/
    liveNodes.test.ts    — requires running containers
```

## Vote validation pipeline (POST /api/vote)
1. **Election rules** — active election, within time window, sender in whitelist, valid candidate
2. **Double-vote** — `State` set, O(1) lookup by lowercase Ethereum address
3. **ECDSA** — `ethers.verifyMessage(JSON.stringify({senderPublicKey, candidateId, electionId, timestamp}), signature)`

## Auto-wipe (shared `scheduleAutoWipe()` in server.ts)
Called by both Gateway (from POST /api/election) and Validators (from ELECTION subscription). Fires after `endTime - now` ms:
1. Tally votes from chain (Gateway only — saves to `lastTally`)
2. `BlockModel.deleteMany({})`
3. `blockchain.resetToGenesis()` + `txPool.clearPool()` + `electionState.clear()` + `election.deactivate()`
4. `BlockModel.create(genesis.toJSON())`

## Important design constraints
- **No admin auth** — `POST /api/election` has no key check (thesis simplification)
- **Election config is ephemeral** — not persisted to MongoDB; lost on restart
- **Nonce is always 0** — no PoW; block creation is immediate (pure PoA)
- **Gateway does NOT subscribe to votes** — adds to txPool directly in HTTP handler to avoid double-add
- **`fromNode` field on all messages** — subscribers skip messages they published themselves
- **`parseInt` radix bug fixed** — was `parseInt(..., 5)`, now `parseInt(..., 10)` in config.ts
- Genesis block timestamp: `"2026-01-01T00:00:00.000Z"`

## RabbitMQ management UI
http://localhost:15672 — admin / admin — only available when containers are running.

## Testing notes
- `jest --runInBand` required — tests share state
- Unit tests mock `src/db/models.js` (BlockModel) and callback functions — no live broker needed
- Integration tests call live HTTP endpoints — need `podman-compose up` first
