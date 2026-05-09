# Architecture & Design — Blockchain Voting Platform

## The system in one sentence

A permissioned blockchain where **votes are transactions**, **sealed into blocks every 15 seconds by designated Validators**, propagated across nodes via **RabbitMQ**, and **wiped automatically** after the election ends so the demo can loop.

---

## Layer by layer

### Layer 1 — The data model (what a block actually is)

A block is just a struct with six fields:

```
index | timestamp | transactions (Vote[]) | previousHash | hash | nonce
```

The `hash` is `SHA-256(index + previousHash + timestamp + nonce + JSON.stringify(transactions))`. That single hash is what makes it a blockchain: block N stores the hash of block N-1. If you change any byte in block N-1, its hash changes, which makes block N's `previousHash` wrong, which makes block N's own stored hash wrong — a cascade that `isChainValid()` catches immediately.

A `Vote` is:

```
senderPublicKey | candidateId | electionId | timestamp | signature
```

The `signature` is an ECDSA signature over `JSON.stringify({senderPublicKey, candidateId, electionId, timestamp})`. The voter signs this with their MetaMask private key. The server calls `ethers.verifyMessage(payload, signature)` which recovers the signer's Ethereum address and checks it matches `senderPublicKey`. You can't forge a vote without the private key.

---

### Layer 2 — The core state machines

There are four independent in-memory singletons per node:

| Singleton | What it holds | Reset on wipe? |
|---|---|---|
| `Blockchain` | `Block[]` — the chain | Yes → `resetToGenesis()` |
| `TransactionPool` | `Vote[]` — pending, not yet sealed | Yes → `clearPool()` |
| `Election` | `ElectionConfig` — current election rules | Yes → `deactivate()` |
| `State` | `Set<string>` — voters who already voted | Yes → `clear()` |

These never talk to each other directly. `server.ts` is the glue that coordinates them.

---

### Layer 3 — Node roles (Proof-of-Authority)

**Proof-of-Authority** means only a pre-approved list of nodes can create blocks. Here:

- **Gateway** (`IS_VALIDATOR=false`): the HTTP front-door. Validates votes (3 layers) and broadcasts them via RabbitMQ. Never mines. This is analogous to a Hyperledger Fabric SDK Gateway — a trusted relay, not a consensus participant.
- **Validators 1–3** (`IS_VALIDATOR=true`): receive votes from RabbitMQ, accumulate them in their mempools, and every 15 seconds seal the mempool into a new block.

The key security property: even if the Gateway is compromised, the attacker can only inject pending transactions. Validators still control what ends up on the chain.

---

### Layer 4 — The message bus (RabbitMQ replacing WebSocket P2P)

The old P2P layer maintained WebSocket connections between every pair of nodes (full-mesh topology) and had to hand-code connection management, reconnect logic, request/response ping-pong, and duplicate-message prevention.

RabbitMQ replaces that with four **fanout exchanges**:

```
voting.votes       → every Validator receives every accepted vote
voting.election    → every node receives the election config
voting.blocks      → every node receives every mined block
voting.chain-req   → every node receives chain sync requests
```

Fanout means "publish once, deliver to everyone who subscribed." Each node has its own named queue per exchange (`votes.validator-1`, `blocks.gateway`, etc.), so no messages are shared between nodes — each gets its own copy.

The `fromNode` field on every message lets subscribers skip their own publications (a node broadcasting a block doesn't need to receive it back and try to append it to its own chain).

---

### Layer 5 — Chain sync (the hard part)

Blocks from multiple Validators can arrive out of order. When a node receives a block it can't append because it's missing the one before it:

1. `ChainSyncService.handleReceivedBlock()` detects the gap (`receivedBlock.index > latestLocal.index + 1` or wrong `previousHash`).
2. Calls `messageBus.requestFullChain()` which:
   - Sets up a temporary consumer on its private `chain-res.{nodeName}` queue
   - Publishes a `CHAIN_REQUEST` to `voting.chain-req` with the reply queue embedded
   - Waits 5 seconds collecting responses
3. Every other node receives the request and responds with its full chain to the reply queue.
4. After the timeout, `requestFullChain()` returns all received chains.
5. `tryReplaceChain()` picks the longest, validates every hash link and block hash, and if valid and longer, replaces the local chain and wipes MongoDB.

This is the **longest-valid-chain rule** — same principle as Bitcoin, but without PoW difficulty.

---

### Layer 6 — Auto-wipe (repeatable demos)

The thesis demo needs to be repeatable: one full election cycle (~60 seconds), then immediately start another without restarting containers.

When the election timer fires (scheduled by `scheduleAutoWipe()` in `server.ts`):

1. **Tally** votes from the sealed chain (Gateway stores this in `lastTally` for the results endpoint).
2. **Wipe MongoDB** — `BlockModel.deleteMany({})`.
3. **Reset memory** — `resetToGenesis()`, `clearPool()`, `electionState.clear()`, `election.deactivate()`.
4. **Re-persist genesis** — so MongoDB is never left empty.

Both the Gateway (from POST /api/election) and Validators (from the ELECTION message subscription) schedule their own auto-wipe timer independently. They fire at the same wall-clock time because they both compute `delayMs = config.endTime - Date.now()`.

---

## Key architectural invariants

1. **The blockchain is the immutable ledger.** Every vote that makes it into a sealed block is there forever (until auto-wipe). No vote can be modified after sealing.

2. **Double-vote prevention is enforced at the HTTP layer.** The `State` set on the Gateway tracks who has already voted. This is O(1) lookup, critical for throughput. In a production multi-Gateway setup, this would need to be shared state (Redis) or consensus-level deduplication.

3. **Every node validates independently.** When a node receives a block, it reconstructs it from the serialised data, recomputes the SHA-256 hash, and compares to the stored hash. A tampered block is caught immediately.

4. **Election config is broadcast, not stored.** The `Election.activate()` call populates in-memory config on every node. There is no `ElectionModel` in MongoDB. This is a thesis simplification — in production, the config would be a transaction on the chain itself or persisted separately.

5. **MongoDB is for durability, not consensus.** The in-memory chain is the source of truth. MongoDB is just a write-ahead log. If a node crashes and restarts, it can recover blocks from MongoDB, but it validates every hash link before accepting them.

6. **RabbitMQ is for distribution, not consensus.** The broker ensures every node receives every message eventually, but it does NOT resolve conflicts. If two Validators mine simultaneously, both blocks are broadcast, and the receiving nodes use the longest-valid-chain rule to pick one.

---

## Why this architecture for a thesis

**Goal:** Demonstrate a tamper-evident voting system in ~60 seconds, repeatedly.

**Trade-off:** Simplicity over production robustness.

- **No sharding:** All Validators see all votes. Simpler, doesn't scale, fine for thesis.
- **No mempool fee market:** Validators seal votes in order received. Fairer than Bitcoin's auction model for voting, but doesn't optimize throughput.
- **No transaction pruning:** The chain is never compacted. Fine for a demo; in production you'd need state snapshots or sharding.
- **No BFT consensus:** Validators are trusted (PoA), so we don't need Byzantine-tolerant quorum commits. Simpler code, but assumes Validators don't collude.
- **Auto-wipe:** Erases the entire chain after each election. In production, you'd archive old elections and maintain a long-running chain.

---

## Defending the design choices

**Q: Why not just use a database?**
A database is mutable — any admin can edit rows. A blockchain is append-only and each block cryptographically commits to all previous blocks via SHA-256. Any retroactive tampering is detectable by `isChainValid()`. For a voting system, this immutability and auditability are core requirements.

**Q: Why Proof-of-Authority and not Proof-of-Work?**
PoW burns energy to produce difficulty (a hash with N leading zeros). In a permissioned system where you already know and trust the validator identities, that energy expenditure provides no additional security — PoA gives you the same tamper-resistance with far less computational cost. For a thesis demo on limited hardware, PoA is practical.

**Q: Why RabbitMQ instead of direct WebSocket connections?**
A full-mesh WebSocket topology requires each node to maintain N-1 connections and implement its own reconnect logic, message deduplication, and request/response protocol. RabbitMQ externalises all of that: the broker handles fan-out, delivery guarantees, and HA. The application code only needs to publish and subscribe. See `RABBITMQ_DEFENSE.md` for a deep dive.

**Q: What does the 3-node RabbitMQ cluster give you?**
A quorum of 2 out of 3 nodes is always available. If any one broker node crashes, the remaining two maintain majority and the cluster keeps serving messages — the election continues uninterrupted. This demonstrates HA and resilience without manual intervention.

---

## The three diagrams

See the Mermaid diagrams in the inline documentation above for:
1. Architecture (containers, databases, RabbitMQ cluster)
2. Class diagram (Block, Blockchain, Election, State, TransactionPool, ChainSyncService, MessageBus)
3. Sequence diagrams (election init, vote casting, mining+sync, auto-wipe)
