# Instruction Manual — Blockchain Voting Platform

This guide assumes you wrote the original codebase and need a refresher after some time away.

---

## 1. What the system does

A private Proof-of-Authority (PoA) blockchain for running electronic elections. Voters submit ECDSA-signed ballots via a browser UI. Validators seal those ballots into tamper-evident blocks. After the election timer expires, results are tallied from the sealed chain and the system resets automatically.

**Key academic concepts demonstrated:**
- Hash-linked blocks (SHA-256, tamper-evidence)
- ECDSA vote signatures (`ethers.verifyMessage`, secp256k1)
- Proof-of-Authority consensus (designated Validators, not PoW)
- Distributed messaging via RabbitMQ (replaces custom WebSocket P2P)
- MongoDB persistence of the immutable ledger

---

## 2. Architecture overview

```
Browser (voter/admin)
        │ HTTP
        ▼
  ┌─────────────┐       AMQP (votes, election, blocks)
  │   Gateway   │ ──────────────────────────────────────►  ┌─────────────────────────┐
  │  (Node A)   │ ◄──────────────────────────────────────  │  RabbitMQ cluster        │
  └─────────────┘                                          │  rabbitmq-1 (primary)    │
                                                           │  rabbitmq-2 (replica)    │
  Validator 1–3  ◄──────────────────────────────────────  │  rabbitmq-3 (replica)    │
  (mine blocks)  ──────────────────────────────────────►  └─────────────────────────┘
```

**Gateway** (`IS_VALIDATOR=false`):
- Serves voter UI (`public/index.html`) and admin UI (`public/admin.html`) on port 3000.
- Validates incoming votes (3-layer pipeline) and publishes them to RabbitMQ.
- Creates elections and publishes the config to RabbitMQ.
- Never mines blocks.

**Validator** (`IS_VALIDATOR=true`):
- Subscribes to vote messages → fills its mempool (`TransactionPool`).
- Every 15 seconds: drains mempool → mines a block → publishes block to RabbitMQ.
- Subscribes to block messages from other Validators → syncs its chain.
- Port 3000 is not exposed externally.

**RabbitMQ cluster (3 nodes)**:
- `rabbitmq-1` — primary broker, exposes AMQP on port 5672 and management UI on port 15672.
- `rabbitmq-2`, `rabbitmq-3` — replicas, join the cluster at startup.
- All app containers connect to `rabbitmq-1`. If it goes down, the cluster maintains quorum.

**MongoDB (4 instances, one per app node)**:
- Stores blocks persistently so the chain survives container restarts.
- Each node has its own MongoDB — there is no shared DB.
- MongoDB is only for persistence; the source of truth for validation is always the in-memory chain.

---

## 3. File map

```
src/
  server.ts                  — entry point: HTTP routes, boot sequence, auto-wipe
  utils/
    config.ts                — env var parsing (all config in one place)
    logger.ts                — createLogger() helper
  core/
    Block.ts                 — SHA-256 block, calculateHash(), toJSON()
    Blockchain.ts            — chain array: addBlock(), isChainValid(), resetToGenesis()
    Election.ts              — in-memory election config: activate(), isVoteValid()
    State.ts                 — double-vote tracker (Set<string> of voter addresses)
    TransactionPool.ts       — mempool: addTransaction(), clearPool(), removeMinedTransactions()
  network/
    messageBus.ts            — RabbitMQ client: connect, publish*, subscribe* (replaces p2p.ts)
    messageTypes.ts          — typed message interfaces: VoteMessage, BlockMessage, etc.
    chainSyncService.ts      — decides append vs full-chain-replace when a block arrives
    transactionGossipService.ts — parses vote payloads and adds them to the mempool
    p2p.ts                   — DEPRECATED stub (safe to delete)
  db/
    connection.ts            — connectToDatabase() with retry
    models.ts                — Mongoose BlockModel schema
  models/
    block.ts                 — IBlock interface
    vote.ts                  — Vote interface
    index.ts                 — re-exports
public/
  index.html + voter.js      — voter ballot UI (MetaMask wallet required)
  admin.html + admin.js      — admin panel: create elections, inspect chain
tests/
  unit/
    chainSyncService.test.ts
    transactionGossipService.test.ts
  integration/
    liveNodes.test.ts        — requires running containers
  jest.setup.ts              — jest.setTimeout(30000)
```

---

## 4. Environment variables

| Variable | Default | Description |
|---|---|---|
| `NODE_NAME` | `node-local` | Human-readable name, used in logs and RabbitMQ queue names |
| `PORT` / `HTTP_PORT` | `3000` | Express HTTP port |
| `MONGO_URI` | `mongodb://localhost:27017/voting_node_db` | MongoDB connection string |
| `RABBITMQ_URL` | `amqp://admin:admin@localhost:5672` | AMQP broker URL |
| `IS_VALIDATOR` | `false` | Set to `"true"` to enable the mining loop |
| `VALIDATOR_INTERVAL_MS` | `15000` | Mining cycle interval in milliseconds |

---

## 5. Running locally (development)

### Option A — Dev server (no containers)

You need a local MongoDB and RabbitMQ running first.

```bash
# Terminal 1 — MongoDB
mongod --dbpath /tmp/mongo-dev

# Terminal 2 — RabbitMQ
rabbitmq-server

# Terminal 3 — Node (Gateway mode)
NODE_NAME=dev IS_VALIDATOR=false npm run dev

# Terminal 4 — Node (Validator mode, different port)
NODE_NAME=validator PORT=3001 IS_VALIDATOR=true npm run dev
```

### Option B — All containers (recommended for demos)

```bash
# Build images and start all 11 containers (3 RabbitMQ + 4 MongoDB + 4 app).
podman-compose up --build

# Follow logs from all containers.
podman-compose logs -f

# Follow logs from one container.
podman-compose logs -f gateway-app

# Stop and remove everything including named volumes (full reset).
podman-compose down -v
```

The Gateway is the only container with an external port: **http://localhost:3000**.

---

## 6. Running a demo election

1. Open **http://localhost:3000/admin.html** in a browser.
2. Fill in candidates (comma-separated), paste voter Ethereum addresses (one per line), and set a duration (e.g. 120 seconds).
3. Click **Start Election**.
4. Open **http://localhost:3000** in another tab (or window). Connect MetaMask and vote.
5. Wait for the timer. Results appear automatically on the admin page.
6. The chain is wiped automatically. You can immediately start another election.

---

## 7. Running tests

```bash
npm test              # all tests (unit + integration) — requires --runInBand
npm run test:unit     # unit tests only (no live containers needed)
npm run test:integration  # requires containers running at localhost:3000
```

**Why `--runInBand`?** Tests share in-memory state via jest globals. Running them in parallel causes races between test suites.

To run integration tests against a specific host:
```bash
LIVE_NODE_URL=http://192.168.1.5:3000 npm run test:integration
```

---

## 8. Building for production

```bash
npm run build   # tsc → dist/
npm start       # node dist/server.js
```

The `Dockerfile` does both stages (build + runtime) so `podman-compose up --build` always uses a fresh compiled image.

---

## 9. RabbitMQ management UI

Available at **http://localhost:15672** when containers are running.

- Username: `admin`, Password: `admin`
- Shows all exchanges, queues, message rates, and cluster health.
- Useful for debugging: check if messages are accumulating in a queue (means a subscriber isn't consuming) or if the cluster is healthy (all 3 nodes should show green).

**Key exchanges to look for:**
- `voting.votes` — vote gossip (Gateway → Validators)
- `voting.election` — election config (Gateway → all)
- `voting.blocks` — mined blocks (Validators → all)
- `voting.chain-req` — chain sync requests

**Key queues (one per node per exchange):**
- `votes.validator-1`, `votes.validator-2`, `votes.validator-3`
- `blocks.gateway`, `blocks.validator-1`, etc.

---

## 10. RabbitMQ message flow (step by step)

### Starting an election

```
Admin browser
  └─► POST /api/election (gateway:3000)
        └─► election.activate(config)          [gateway in-memory]
        └─► messageBus.publishElection(config)  [→ voting.election exchange]
              └─► election.{nodeName} queues    [all nodes receive it]
                    └─► election.activate(config)  [each node activates in-memory]
                    └─► scheduleAutoWipe(config)   [each node sets its own timer]
```

### Casting a vote

```
Voter browser (MetaMask)
  └─► POST /api/vote (gateway:3000)
        └─► election.isVoteValid(vote)      [layer 1: election rules]
        └─► electionState.hasVoted(addr)    [layer 2: double-vote check]
        └─► ethers.verifyMessage(...)       [layer 3: ECDSA signature]
        └─► txPool.addTransaction(vote)     [gateway local mempool]
        └─► messageBus.publishVote(vote)    [→ voting.votes exchange]
              └─► votes.validator-N queues  [validators receive it]
                    └─► txPool.addTransaction(vote)  [validator mempools]
```

### Mining a block (every 15 seconds on each Validator)

```
setInterval fires on validator-N
  └─► txPool.getTransactions()           [drain mempool]
  └─► blockchain.addBlock(votes)         [seal into new block]
  └─► BlockModel.create(block)           [persist to this validator's MongoDB]
  └─► messageBus.publishBlock(block)     [→ voting.blocks exchange]
        └─► blocks.{nodeName} queues     [all other nodes receive it]
              └─► chainSync.handleReceivedBlock(block)
                    ├─► [extends tip]  → blockchain.chain.push(block)
                    └─► [gap] → messageBus.requestFullChain()
                                    └─► chain-req.{nodeName} queues
                                          └─► each node responds with full chain
                                    └─► pick longest valid chain → replace local
```

### Auto-wipe (when election timer expires)

```
setTimeout fires on all nodes
  └─► Tally votes from blockchain.chain    [gateway only — stores lastTally]
  └─► BlockModel.deleteMany({})            [wipe MongoDB]
  └─► blockchain.resetToGenesis()          [reset in-memory chain]
  └─► txPool.clearPool()
  └─► electionState.clear()
  └─► election.deactivate()
  └─► BlockModel.create(genesis)           [re-persist fresh genesis]
```

---

## 11. Code architecture decisions to know

### Why callbacks in ChainSyncService?
`ChainSyncService` receives two functions at construction time instead of a direct reference to `MessageBus`. This means the unit tests can mock them without touching RabbitMQ at all — the sync logic is fully tested in isolation.

### Why does the Gateway NOT subscribe to its own vote messages?
The Gateway adds votes to `txPool` directly in the HTTP handler *before* publishing to RabbitMQ. If it also subscribed to the `voting.votes` exchange, the same vote would be added to `txPool` twice. Since the Gateway is not a Validator (never mines blocks), this would be harmless but confusing.

### Why is the election config ephemeral (not persisted to MongoDB)?
Design choice for the thesis demo. If a node restarts mid-election, it loses the config. In a production system, the config would be a transaction on the chain itself. For the demo, the auto-wipe + restart cycle makes this a non-issue.

### Why `fromNode` on every message?
Nodes subscribe to fanout exchanges, which means they receive their own published messages back. The `fromNode` field allows each subscriber to skip messages it published itself (e.g. a Validator should not add its own mined block back to the chain).

### The `parseInt` radix bug (fixed)
The original code had `parseInt(process.env["VALIDATOR_INTERVAL_MS"] ?? "15000", 5)`. Radix `5` means parse as base-5 — a silent bug that would produce wildly wrong intervals for most values. Fixed to radix `10` in `config.ts`.

---

## 12. Common problems

| Symptom | Likely cause | Fix |
|---|---|---|
| App containers restart-loop | RabbitMQ or MongoDB not healthy yet | Wait 60s for startup; check `podman-compose logs rabbitmq-1` |
| "Not connected" on /api/peers | MessageBus failed to connect | Check RABBITMQ_URL env var and broker health |
| Blocks not propagating | Validator mining loop not running | Check IS_VALIDATOR=true on validator containers |
| Chain keeps resetting | Auto-wipe timer fired | Normal — start a new election |
| Vote rejected "No active election" | No election was created | Go to admin.html and create one |
| Vote rejected "Address not in whitelist" | Voter's Ethereum address not in whitelist | Re-create election with the correct addresses |
| RabbitMQ cluster not forming | Erlang cookie mismatch or timing | Ensure all nodes share the same RABBITMQ_ERLANG_COOKIE; try `podman-compose down -v && podman-compose up --build` |
