// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Vorion LLC

/**
 * SQLite Stores Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import { SQLiteProofStore, createSQLiteProofStore } from '../sqlite-proof-store.js';
import { SQLiteTrustStore, createSQLiteTrustStore, type AgentTrustRecord, type TrustSignalRecord } from '../sqlite-trust-store.js';
import type { ProofBatch, ProofCommitment, ProofEventType } from '../../proof-committer/types.js';

describe('SQLiteProofStore', () => {
  let store: SQLiteProofStore;

  beforeEach(() => {
    // Use in-memory database for tests
    store = createSQLiteProofStore({ dbPath: ':memory:' });
  });

  afterEach(() => {
    store.close();
  });

  const createTestBatch = (batchId: string, commitmentCount: number): ProofBatch => {
    const commitments: ProofCommitment[] = [];

    for (let i = 0; i < commitmentCount; i++) {
      commitments.push({
        id: `commitment-${batchId}-${i}`,
        hash: crypto.createHash('sha256').update(`test-${i}`).digest('hex'),
        timestamp: Date.now(),
        event: {
          type: 'intent_submitted' as ProofEventType,
          entityId: `agent-${i % 3}`, // Distribute across 3 agents
          payload: { action: 'read', resource: `file-${i}.txt` },
          timestamp: Date.now(),
          correlationId: `corr-${batchId}`,
        },
      });
    }

    return {
      batchId,
      merkleRoot: crypto.createHash('sha256').update(batchId).digest('hex'),
      signature: 'test-signature',
      createdAt: new Date(),
      eventCount: commitmentCount,
      commitments,
    };
  };

  it('should create store with in-memory database', () => {
    expect(store).toBeDefined();
    const stats = store.getStats();
    expect(stats.batches).toBe(0);
    expect(stats.commitments).toBe(0);
  });

  it('should write and retrieve a batch', async () => {
    const batch = createTestBatch('batch-1', 5);

    await store.writeBatch(batch);

    const retrieved = await store.getBatch('batch-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.batchId).toBe('batch-1');
    expect(retrieved!.merkleRoot).toBe(batch.merkleRoot);
    expect(retrieved!.eventCount).toBe(5);
    expect(retrieved!.commitments.length).toBe(5);
  });

  it('should retrieve individual commitments', async () => {
    const batch = createTestBatch('batch-2', 3);
    await store.writeBatch(batch);

    const commitment = await store.getCommitment('commitment-batch-2-1');
    expect(commitment).not.toBeNull();
    expect(commitment!.id).toBe('commitment-batch-2-1');
    expect(commitment!.event.type).toBe('intent_submitted');
  });

  it('should get commitments for an entity', async () => {
    const batch1 = createTestBatch('batch-3', 6);
    const batch2 = createTestBatch('batch-4', 6);
    await store.writeBatch(batch1);
    await store.writeBatch(batch2);

    // Agent-0 should have 4 commitments (2 from each batch of 6)
    const commitments = await store.getCommitmentsForEntity('agent-0');
    expect(commitments.length).toBe(4);
  });

  it('should return null for non-existent batch', async () => {
    const batch = await store.getBatch('non-existent');
    expect(batch).toBeNull();
  });

  it('should return null for non-existent commitment', async () => {
    const commitment = await store.getCommitment('non-existent');
    expect(commitment).toBeNull();
  });

  it('should clear all data', async () => {
    const batch = createTestBatch('batch-5', 5);
    await store.writeBatch(batch);

    let stats = store.getStats();
    expect(stats.batches).toBe(1);
    expect(stats.commitments).toBe(5);

    store.clear();

    stats = store.getStats();
    expect(stats.batches).toBe(0);
    expect(stats.commitments).toBe(0);
  });

  it('should handle batch with correlation IDs', async () => {
    const batch = createTestBatch('batch-6', 2);
    await store.writeBatch(batch);

    const commitment = await store.getCommitment('commitment-batch-6-0');
    expect(commitment!.event.correlationId).toBe('corr-batch-6');
  });
});

describe('SQLiteTrustStore', () => {
  let store: SQLiteTrustStore;

  beforeEach(() => {
    store = createSQLiteTrustStore({ dbPath: ':memory:' });
  });

  afterEach(() => {
    store.close();
  });

  const createTestAgent = (agentId: string): AgentTrustRecord => ({
    agentId,
    name: `Test Agent ${agentId}`,
    score: 500,
    tier: 3,
    observationTier: 'GRAY_BOX',
    observationCeiling: 800,
    capabilities: ['read:*', 'write:*'],
    admittedAt: new Date(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    lastActivityAt: new Date(),
    isRevoked: false,
  });

  const createTestSignal = (agentId: string, type: TrustSignalRecord['type']): TrustSignalRecord => ({
    id: crypto.randomUUID(),
    agentId,
    type,
    source: 'test',
    weight: 0.5,
    scoreBefore: 500,
    scoreAfter: type === 'success' ? 502 : 480,
    context: { action: 'read' },
    timestamp: new Date(),
  });

  it('should create store with in-memory database', () => {
    expect(store).toBeDefined();
    const stats = store.getStats();
    expect(stats.agents).toBe(0);
    expect(stats.signals).toBe(0);
  });

  it('should save and retrieve an agent', async () => {
    const agent = createTestAgent('agent-1');
    await store.saveAgent(agent);

    const retrieved = await store.getAgent('agent-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.agentId).toBe('agent-1');
    expect(retrieved!.name).toBe('Test Agent agent-1');
    expect(retrieved!.score).toBe(500);
    expect(retrieved!.tier).toBe(3);
    expect(retrieved!.capabilities).toEqual(['read:*', 'write:*']);
    expect(retrieved!.isRevoked).toBe(false);
  });

  it('should update agent on conflict (upsert)', async () => {
    const agent = createTestAgent('agent-2');
    await store.saveAgent(agent);

    // Update the agent
    agent.score = 600;
    agent.tier = 4;
    await store.saveAgent(agent);

    const retrieved = await store.getAgent('agent-2');
    expect(retrieved!.score).toBe(600);
    expect(retrieved!.tier).toBe(4);
  });

  it('should update agent score', async () => {
    const agent = createTestAgent('agent-3');
    await store.saveAgent(agent);

    await store.updateScore('agent-3', 650, 4);

    const retrieved = await store.getAgent('agent-3');
    expect(retrieved!.score).toBe(650);
    expect(retrieved!.tier).toBe(4);
  });

  it('should revoke an agent', async () => {
    const agent = createTestAgent('agent-4');
    await store.saveAgent(agent);

    await store.revokeAgent('agent-4', 'Security violation');

    const retrieved = await store.getAgent('agent-4');
    expect(retrieved!.isRevoked).toBe(true);
    expect(retrieved!.revokedReason).toBe('Security violation');
  });

  it('should record and retrieve trust signals', async () => {
    const agent = createTestAgent('agent-5');
    await store.saveAgent(agent);

    const signal1 = createTestSignal('agent-5', 'success');
    const signal2 = createTestSignal('agent-5', 'failure');
    await store.recordSignal(signal1);
    await store.recordSignal(signal2);

    const signals = await store.getSignals('agent-5');
    expect(signals.length).toBe(2);
  });

  it('should limit signals returned', async () => {
    const agent = createTestAgent('agent-6');
    await store.saveAgent(agent);

    // Record 5 signals
    for (let i = 0; i < 5; i++) {
      await store.recordSignal(createTestSignal('agent-6', 'success'));
    }

    const signals = await store.getSignals('agent-6', 3);
    expect(signals.length).toBe(3);
  });

  it('should list active agents', async () => {
    const agent1 = createTestAgent('agent-7');
    const agent2 = createTestAgent('agent-8');
    const agent3 = createTestAgent('agent-9');

    await store.saveAgent(agent1);
    await store.saveAgent(agent2);
    await store.saveAgent(agent3);

    // Revoke one
    await store.revokeAgent('agent-8', 'Test revocation');

    const activeAgents = await store.listActiveAgents();
    expect(activeAgents.length).toBe(2);
    expect(activeAgents.map((a) => a.agentId)).not.toContain('agent-8');
  });

  it('should return null for non-existent agent', async () => {
    const agent = await store.getAgent('non-existent');
    expect(agent).toBeNull();
  });

  it('should clear all data', async () => {
    const agent = createTestAgent('agent-10');
    await store.saveAgent(agent);
    await store.recordSignal(createTestSignal('agent-10', 'success'));

    let stats = store.getStats();
    expect(stats.agents).toBe(1);
    expect(stats.signals).toBe(1);

    store.clear();

    stats = store.getStats();
    expect(stats.agents).toBe(0);
    expect(stats.signals).toBe(0);
  });

  it('should parse context correctly', async () => {
    const agent = createTestAgent('agent-11');
    await store.saveAgent(agent);

    const signal = createTestSignal('agent-11', 'success');
    signal.context = { action: 'read', resource: 'test.txt', nested: { key: 'value' } };
    await store.recordSignal(signal);

    const signals = await store.getSignals('agent-11');
    expect(signals[0].context).toEqual({ action: 'read', resource: 'test.txt', nested: { key: 'value' } });
  });
});
