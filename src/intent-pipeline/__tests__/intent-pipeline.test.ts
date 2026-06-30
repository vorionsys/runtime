// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Vorion LLC

/**
 * IntentPipeline Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IntentPipeline, createIntentPipeline } from '../index.js';
import { createTrustFacade, TrustFacade } from '../../trust-facade/index.js';
import { createProofCommitter, ProofCommitter, InMemoryProofStore } from '../../proof-committer/index.js';
import type { AgentCredentials, Action } from '../../trust-facade/index.js';

describe('IntentPipeline', () => {
  let pipeline: IntentPipeline;
  let trustFacade: TrustFacade;
  let proofCommitter: ProofCommitter;
  let proofStore: InMemoryProofStore;

  const testAgent: AgentCredentials = {
    agentId: 'test-agent-1',
    name: 'Test Agent',
    capabilities: ['read:*', 'write:*'], // Wildcard capabilities for all resources
    observationTier: 'GRAY_BOX',
  };

  const testAction: Action = {
    type: 'read',
    resource: 'documents/test.pdf',
    parameters: {},
  };

  beforeEach(() => {
    proofStore = new InMemoryProofStore();
    trustFacade = createTrustFacade();
    proofCommitter = createProofCommitter(
      { maxBufferSize: 100, flushIntervalMs: 10000 },
      proofStore
    );
    pipeline = createIntentPipeline(trustFacade, proofCommitter, {
      verboseLogging: false,
    });
  });

  afterEach(async () => {
    await pipeline.stop();
  });

  describe('submit', () => {
    it('should process an intent and return result', async () => {
      const result = await pipeline.submit(testAgent, testAction);

      expect(result).toBeDefined();
      expect(result.intentId).toBeDefined();
      expect(typeof result.allowed).toBe('boolean');
      expect(['GREEN', 'YELLOW', 'RED']).toContain(result.tier);
      expect(result.commitmentId).toBeDefined();
      expect(result.processingTimeMs).toBeGreaterThan(0);
    });

    it('should create proof commitments', async () => {
      await pipeline.submit(testAgent, testAction);
      await pipeline.flushProofs();

      const commitments = await proofStore.getCommitmentsForEntity(testAgent.agentId);
      expect(commitments.length).toBeGreaterThan(0);

      // Should have at least intent_submitted and decision_made
      const types = commitments.map((c) => c.event.type);
      expect(types).toContain('intent_submitted');
      expect(types).toContain('decision_made');
    });

    it('should track metrics', async () => {
      await pipeline.submit(testAgent, testAction);
      await pipeline.submit(testAgent, testAction);

      const metrics = pipeline.getMetrics();

      expect(metrics.totalIntents).toBe(2);
      expect(metrics.avgProcessingTimeMs).toBeGreaterThan(0);
    });

    it('should handle execution handlers', async () => {
      let handlerCalled = false;

      pipeline.registerHandler('read', async (intent, context) => {
        handlerCalled = true;
        return { success: true, result: { data: 'test' } };
      });

      const result = await pipeline.submit(testAgent, testAction);

      expect(handlerCalled).toBe(true);
      expect(result.allowed).toBe(true);
    });

    it('should handle execution failures', async () => {
      pipeline.registerHandler('read', async () => {
        return { success: false, error: 'Permission denied' };
      });

      const result = await pipeline.submit(testAgent, testAction);

      expect(result.reason).toContain('Execution failed');
    });

    it('should preserve correlation ID across proofs', async () => {
      await pipeline.submit(testAgent, testAction);
      await pipeline.flushProofs();

      const commitments = await proofStore.getCommitmentsForEntity(testAgent.agentId);

      // All commitments for this intent should have same correlation ID
      const correlationIds = new Set(commitments.map((c) => c.event.correlationId));
      expect(correlationIds.size).toBe(1);
    });
  });

  describe('check', () => {
    it('should check authorization without execution', async () => {
      const result = await pipeline.check(testAgent, testAction);

      expect(result).toBeDefined();
      expect(typeof result.allowed).toBe('boolean');
      expect(result.tier).toBeDefined();
      expect(result.reason).toBeDefined();
    });

    it('should not create proof commitments on check', async () => {
      const initialStats = proofStore.getStats();

      await pipeline.check(testAgent, testAction);
      await pipeline.flushProofs();

      // No new commitments should be created for check
      // (check is a dry run)
      expect(proofStore.getStats().commitments).toBe(initialStats.commitments);
    });
  });

  describe('metrics', () => {
    it('should track allowed vs denied intents', async () => {
      // Submit multiple intents
      await pipeline.submit(testAgent, testAction);
      await pipeline.submit(testAgent, testAction);

      const metrics = pipeline.getMetrics();

      expect(metrics.totalIntents).toBe(2);
      expect(metrics.allowedIntents + metrics.deniedIntents).toBe(2);
      expect(metrics.allowRate).toBeGreaterThanOrEqual(0);
      expect(metrics.allowRate).toBeLessThanOrEqual(1);
    });
  });
});
