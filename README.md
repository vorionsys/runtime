# @vorionsys/runtime

Orchestration layer for AI agent governance, built on the [Vorion](https://github.com/vorionsys/vorion) trust framework and aligned with the BASIS (Baseline Authority for Safe & Interoperable Systems) specification.

Combines **Gate Trust** (one-time admission control) and **Dynamic Trust** (per-action real-time scoring) into a unified, fast decision system with cryptographic proof of every governance decision.

## Installation

```bash
npm install @vorionsys/runtime
```

**Peer dependencies** (optional, enhance functionality):

```bash
npm install @vorionsys/atsf-core @vorionsys/contracts
```

## Quick Start

```typescript
import {
  createTrustFacade,
  createProofCommitter,
  createIntentPipeline,
} from '@vorionsys/runtime';

// 1. Create the trust facade (Gate Trust + Dynamic Trust)
const facade = createTrustFacade();

// 2. Create the proof committer (cryptographic audit trail)
const committer = createProofCommitter();

// 3. Wire them together with the intent pipeline
const pipeline = createIntentPipeline(facade, committer);

// 4. Admit an agent (Gate Trust - "the door")
const admission = await facade.admit({
  agentId: 'agent-123',
  name: 'DataProcessor',
  capabilities: ['read:data', 'write:reports'],
  observationTier: 'GRAY_BOX',
});

console.log(admission.admitted);          // true
console.log(admission.initialScore);      // 200 (GRAY_BOX initial)
console.log(admission.observationCeiling); // 800

// 5. Authorize an action (Dynamic Trust - "the handshake")
const auth = await facade.authorize('agent-123', {
  type: 'read',
  resource: 'data/users',
});

if (auth.allowed) {
  console.log('Decision tier:', auth.tier);         // 'GREEN'
  console.log('Constraints:', auth.constraints);    // { timeoutMs, maxOperations, ... }
}
```

## What It Provides

| Component | Purpose |
|---|---|
| **TrustFacade** | Unified API combining gate trust (admission) and dynamic trust (per-action authorization) with an 8-tier trust model (T0-T7) |
| **ProofCommitter** | Zero-latency synchronous hash commitment (<1ms) with async Merkle-tree batching and optional Ed25519 signing |
| **IntentPipeline** | End-to-end orchestration: Intent -> Gate Check -> Authorization -> Execution -> Proof |
| **SQLiteProofStore** | Persistent proof storage backed by better-sqlite3 with WAL mode |
| **SQLiteTrustStore** | Persistent agent trust records and signal history backed by better-sqlite3 |
| **InMemoryProofStore** | In-memory proof store for testing and development |

## Core Concepts

### Trust Tiers (T0-T7)

Agents are assigned a numeric trust score (0-1000) that maps to one of eight tiers:

| Tier | Name | Score Range |
|------|------|-------------|
| T0 | Untrusted | 0-99 |
| T1 | Provisional | 100-199 |
| T2 | Basic | 200-349 |
| T3 | Monitored | 350-499 |
| T4 | Standard | 500-649 |
| T5 | Trusted | 650-799 |
| T6 | Elevated | 800-899 |
| T7 | Autonomous | 900-1000 |

### Observation Tiers

Agent visibility determines the maximum trust score (ceiling) an agent can achieve:

- **BLACK_BOX** -- Opaque internals, ceiling at 500 (max T3)
- **GRAY_BOX** -- Partial visibility, ceiling at 800 (max T5)
- **WHITE_BOX** -- Full visibility, ceiling at 1000 (max T7)

### Decision Tiers

Every authorization returns one of three decision tiers:

- **GREEN** -- Allowed with standard constraints
- **YELLOW** -- Allowed with additional constraints and refinement options
- **RED** -- Denied

### Asymmetric Trust Dynamics

Trust is hard to earn and easy to lose. Failures are penalized 10x more than successes reward, preventing rapid trust escalation while enforcing accountability.

## Subpath Imports

Each major component is available as a subpath import:

```typescript
// Root -- all exports
import { createTrustFacade, createProofCommitter, createIntentPipeline } from '@vorionsys/runtime';

// Trust facade only
import { createTrustFacade, TrustFacade } from '@vorionsys/runtime/trust-facade';

// Proof committer only
import { createProofCommitter, ProofCommitter } from '@vorionsys/runtime/proof-committer';

// Intent pipeline only
import { createIntentPipeline, IntentPipeline } from '@vorionsys/runtime/intent-pipeline';

// Persistent stores
import { createSQLiteProofStore, createSQLiteTrustStore } from '@vorionsys/runtime/stores';
```

## API Reference

### TrustFacade

The primary API for agent governance. Implements the `TrustGate` interface.

```typescript
import { createTrustFacade, type TrustFacadeConfig } from '@vorionsys/runtime';

const facade = createTrustFacade({
  // All fields are optional with sensible defaults
  gateTrustCacheTtlMs: 3600000,       // Cache gate trust results for 1 hour
  maxAuthorizationLatencyMs: 50,       // Target latency for authorize()
  useAtsfForPersistence: true,         // Use ATSF-core for persistence
  useA3iForDynamics: true,             // Use A3I for trust dynamics
  primaryScoreSource: 'atsf',          // Primary source for trust scores
});
```

#### `facade.admit(agent: AgentCredentials): Promise<AdmissionResult>`

Gate trust check -- called once at agent registration. Result is cached.

```typescript
const result = await facade.admit({
  agentId: 'agent-123',
  name: 'My Agent',
  capabilities: ['read:data', 'write:reports'],
  observationTier: 'WHITE_BOX',       // 'BLACK_BOX' | 'GRAY_BOX' | 'WHITE_BOX'
  metadata: { version: '1.0' },       // optional
});

// AdmissionResult:
// {
//   admitted: boolean,
//   initialTier: TrustTier,         // 0-7
//   initialScore: number,           // e.g. 300 for WHITE_BOX
//   observationCeiling: number,     // e.g. 1000 for WHITE_BOX
//   capabilities: string[],
//   expiresAt: Date,
//   reason?: string,                // set when admitted === false
// }
```

#### `facade.authorize(agentId: string, action: Action): Promise<AuthorizationResult>`

Dynamic trust check -- called on every action. Must be fast (<50ms target).

```typescript
const auth = await facade.authorize('agent-123', {
  type: 'read',              // 'read' | 'write' | 'delete' | 'execute' | ...
  resource: 'data/users',
  context: { limit: 100 },   // optional
});

// AuthorizationResult:
// {
//   allowed: boolean,
//   tier: DecisionTier,            // 'GREEN' | 'YELLOW' | 'RED'
//   currentScore: number,
//   currentTier: TrustTier,
//   constraints?: Constraints,     // timeoutMs, maxOperations, resourceLimits
//   refinements?: Refinement[],    // YELLOW decisions include refinement options
//   reason: string,
//   latencyMs: number,
// }
```

#### `facade.fullCheck(agent: AgentCredentials, action: Action): Promise<FullCheckResult>`

Combined admission + authorization in a single call. Useful for first-time agent interactions.

```typescript
const result = await facade.fullCheck(agentCredentials, action);

// FullCheckResult:
// {
//   admission: AdmissionResult,
//   authorization?: AuthorizationResult,  // only present if admission.admitted === true
// }
```

#### `facade.recordSignal(signal: TrustSignal): Promise<void>`

Record a trust signal that updates the agent's dynamic trust score.

```typescript
await facade.recordSignal({
  agentId: 'agent-123',
  type: 'success',            // 'success' | 'failure' | 'violation' | 'neutral'
  weight: 0.5,                // 0-1
  source: 'execution-engine',
  context: { intentId: '...' },  // optional
});
```

#### `facade.getScore(agentId: string): Promise<number | null>`

Returns the current trust score, or `null` if the agent is unknown.

#### `facade.getTier(agentId: string): Promise<TrustTier | null>`

Returns the current trust tier (0-7), or `null` if the agent is unknown.

#### `facade.revoke(agentId: string, reason: string): Promise<void>`

Revoke an agent's admission. Clears cached trust data and prevents future authorizations until re-admitted.

---

### ProofCommitter

Zero-latency cryptographic proof system. Synchronous hash commitment on the hot path (<1ms), with asynchronous Merkle-tree batching on the cold path.

```typescript
import { createProofCommitter, type ProofCommitterConfig } from '@vorionsys/runtime';

const committer = createProofCommitter({
  maxBufferSize: 100,        // Auto-flush when buffer reaches this size
  flushIntervalMs: 100,      // Periodic flush interval
  enableSigning: false,      // Enable Ed25519 signing
  privateKey: undefined,     // Base64-encoded Ed25519 private key (required if signing enabled)
});
```

#### `committer.commit(event: ProofEvent): string`

Synchronous hot-path commitment. Returns a commitment ID. Target: <1ms.

```typescript
const commitmentId = committer.commit({
  type: 'intent_submitted',   // ProofEventType
  entityId: 'agent-123',
  payload: { action: 'read', resource: 'data/users' },
  timestamp: Date.now(),
  correlationId: 'corr-456',  // optional, for linking related events
});
```

**ProofEventType values:** `'intent_submitted'` | `'decision_made'` | `'execution_started'` | `'execution_completed'` | `'trust_signal'` | `'agent_admitted'` | `'agent_revoked'` | `'parity_violation'`

#### `committer.flush(): Promise<void>`

Force-flush the buffer. Builds a Merkle tree, optionally signs, and persists to the proof store.

#### `committer.stop(): Promise<void>`

Flush remaining events and stop the periodic flush timer. Call this on shutdown.

#### `committer.getCommitment(commitmentId: string): Promise<ProofCommitment | null>`

Retrieve a commitment from the store by ID.

#### `committer.getCommitmentsForEntity(entityId: string): Promise<ProofCommitment[]>`

Retrieve all commitments for a given entity (agent, intent, etc.).

#### `committer.verifyCommitment(commitment: ProofCommitment): boolean`

Verify a commitment's SHA-256 hash matches the original event.

#### `committer.getMetrics()`

Returns `{ totalCommitments, totalBatches, avgFlushTimeMs, bufferSize }`.

#### `committer.getBufferSize(): number`

Returns the number of uncommitted events in the buffer.

---

### IntentPipeline

Orchestrates the full agent intent lifecycle: **Intent -> Gate Check -> Authorization -> Execution -> Proof**.

```typescript
import { createIntentPipeline, type IntentPipelineConfig } from '@vorionsys/runtime';

const pipeline = createIntentPipeline(trustFacade, proofCommitter, {
  verboseLogging: false,       // Enable detailed logging
  timeoutMs: 5000,             // Maximum processing time
  autoRecordSignals: true,     // Auto-record trust signals on execution
});
```

#### `pipeline.registerHandler(actionType: string, handler: ExecutionHandler): void`

Register an execution handler for an action type.

```typescript
pipeline.registerHandler('read', async (intent, context) => {
  // Execute the intent
  const data = await myDatabase.query(intent.action.resource);
  return { success: true, result: data };
});

pipeline.registerHandler('write', async (intent, context) => {
  try {
    await myDatabase.write(intent.action.resource, intent.metadata);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
```

#### `pipeline.submit(credentials: AgentCredentials, action: Action, metadata?: Record<string, unknown>): Promise<IntentResult>`

Submit an intent for full processing (gate check, authorization, execution, proof).

```typescript
const result = await pipeline.submit(
  {
    agentId: 'agent-123',
    name: 'DataProcessor',
    capabilities: ['read:data'],
    observationTier: 'GRAY_BOX',
  },
  { type: 'read', resource: 'data/users' },
  { limit: 50 },  // optional metadata
);

// IntentResult:
// {
//   intentId: string,
//   allowed: boolean,
//   tier: DecisionTier,          // 'GREEN' | 'YELLOW' | 'RED'
//   reason: string,
//   commitmentId: string,        // proof commitment ID
//   constraints?: string[],
//   processingTimeMs: number,
// }
```

#### `pipeline.check(credentials: AgentCredentials, action: Action): Promise<{ allowed, tier, reason }>`

Quick authorization check without execution.

#### `pipeline.getMetrics()`

Returns `{ totalIntents, allowedIntents, deniedIntents, avgProcessingTimeMs, allowRate }`.

#### `pipeline.flushProofs(): Promise<void>`

Flush all pending proof commitments.

#### `pipeline.stop(): Promise<void>`

Stop the pipeline and flush remaining proofs.

---

### Persistent Stores

SQLite-backed stores for production use. Both use WAL mode by default for better write concurrency.

#### SQLiteProofStore

```typescript
import { createSQLiteProofStore } from '@vorionsys/runtime/stores';

const proofStore = createSQLiteProofStore({
  dbPath: './data/proofs.db',   // Use ':memory:' for in-memory
  walMode: true,                // default: true
});

// Pass to ProofCommitter
const committer = createProofCommitter({ maxBufferSize: 100 }, proofStore);

// Query proofs
const commitment = await proofStore.getCommitment('commitment-id');
const batch = await proofStore.getBatch('batch-id');
const entityProofs = await proofStore.getCommitmentsForEntity('agent-123');

// Housekeeping
proofStore.getStats();  // { batches: number, commitments: number }
proofStore.close();     // Close DB connection on shutdown
```

#### SQLiteTrustStore

```typescript
import { createSQLiteTrustStore } from '@vorionsys/runtime/stores';

const trustStore = createSQLiteTrustStore({
  dbPath: './data/trust.db',    // Use ':memory:' for in-memory
  walMode: true,                // default: true
});

// Save/retrieve agent trust records
await trustStore.saveAgent(agentRecord);
const agent = await trustStore.getAgent('agent-123');

// Update scores
await trustStore.updateScore('agent-123', 450, 3);

// Revoke
await trustStore.revokeAgent('agent-123', 'Policy violation');

// Record and query trust signals
await trustStore.recordSignal(signalRecord);
const signals = await trustStore.getSignals('agent-123', 50);

// List active agents
const agents = await trustStore.listActiveAgents();

// Housekeeping
trustStore.getStats();  // { agents, activeAgents, signals }
trustStore.close();
```

#### InMemoryProofStore

```typescript
import { InMemoryProofStore } from '@vorionsys/runtime';

const store = new InMemoryProofStore();
// Same ProofStore interface, useful for testing
store.getStats();  // { batches: number, commitments: number }
store.clear();     // Reset all data
```

---

### Logger

```typescript
import { createLogger } from '@vorionsys/runtime';

const logger = createLogger({
  component: 'my-component',
  level: 'debug',  // optional, defaults to LOG_LEVEL env var or 'info'
});
```

Uses [pino](https://github.com/pinojs/pino) with pretty-printing in non-production environments.

## Full Example: Intent Pipeline

```typescript
import {
  createTrustFacade,
  createProofCommitter,
  createIntentPipeline,
  createSQLiteProofStore,
} from '@vorionsys/runtime';

// Set up persistent proof storage
const proofStore = createSQLiteProofStore({ dbPath: './data/proofs.db' });

// Create the governance stack
const facade = createTrustFacade();
const committer = createProofCommitter({ maxBufferSize: 50 }, proofStore);
const pipeline = createIntentPipeline(facade, committer, {
  autoRecordSignals: true,
});

// Register execution handlers
pipeline.registerHandler('read', async (intent) => {
  const data = await fetchData(intent.action.resource);
  return { success: true, result: data };
});

// Submit an intent
const result = await pipeline.submit(
  {
    agentId: 'data-agent',
    name: 'Data Agent',
    capabilities: ['read:data'],
    observationTier: 'GRAY_BOX',
  },
  { type: 'read', resource: 'data/reports' },
);

if (result.allowed) {
  console.log(`Intent ${result.intentId} processed in ${result.processingTimeMs}ms`);
  console.log(`Decision: ${result.tier}, Proof: ${result.commitmentId}`);
} else {
  console.log(`Denied: ${result.reason}`);
}

// Graceful shutdown
await pipeline.stop();
proofStore.close();
```

## TypeScript

All types are exported from the root entry point:

```typescript
import type {
  // Trust Facade
  TrustGate,
  TrustFacadeConfig,
  AgentCredentials,
  AdmissionResult,
  Action,
  AuthorizationResult,
  FullCheckResult,
  TrustSignal,
  TrustTier,
  DecisionTier,
  ObservationTier,
  Constraints,
  Refinement,

  // Proof Committer
  ProofEvent,
  ProofEventType,
  ProofCommitment,
  ProofBatch,
  ProofCommitterConfig,
  ProofStore,

  // Intent Pipeline
  Intent,
  IntentResult,
  PipelineContext,
  IntentPipelineConfig,
  ExecutionHandler,

  // Stores
  SQLiteProofStoreConfig,
  SQLiteTrustStoreConfig,
  TrustStore,
  AgentTrustRecord,
  TrustSignalRecord,

  // Logger
  LoggerOptions,
} from '@vorionsys/runtime';
```

## Requirements

- Node.js >= 18.0.0
- TypeScript >= 5.0 (peer dependency)

## License

[Apache-2.0](./LICENSE)

## Links

- [Vorion Monorepo](https://github.com/vorionsys/vorion)
- [BASIS Specification](https://github.com/vorionsys/vorion/tree/main/docs) -- Baseline Authority for Safe & Interoperable Systems
