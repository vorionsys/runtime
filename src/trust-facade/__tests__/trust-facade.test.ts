// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Vorion LLC

/**
 * TrustFacade Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TrustFacade, createTrustFacade } from '../index.js';
import type { AgentCredentials, Action } from '../types.js';

describe('TrustFacade', () => {
  let facade: TrustFacade;

  beforeEach(() => {
    facade = createTrustFacade();
  });

  describe('admit (Gate Trust)', () => {
    it('should admit a valid agent', async () => {
      const agent: AgentCredentials = {
        agentId: 'test-agent-1',
        name: 'Test Agent',
        capabilities: ['read:data', 'write:reports'],
        observationTier: 'WHITE_BOX',
      };

      const result = await facade.admit(agent);

      expect(result.admitted).toBe(true);
      expect(result.initialTier).toBeGreaterThanOrEqual(0);
      expect(result.initialScore).toBeGreaterThan(0);
      expect(result.observationCeiling).toBe(1000); // WHITE_BOX ceiling
      expect(result.capabilities).toContain('read:data');
    });

    it('should assign lower ceiling for BLACK_BOX agents', async () => {
      const agent: AgentCredentials = {
        agentId: 'black-box-agent',
        name: 'Black Box Agent',
        capabilities: ['read:data'],
        observationTier: 'BLACK_BOX',
      };

      const result = await facade.admit(agent);

      expect(result.admitted).toBe(true);
      expect(result.observationCeiling).toBe(500); // BLACK_BOX ceiling
    });

    it('should cache admission results', async () => {
      const agent: AgentCredentials = {
        agentId: 'cached-agent',
        name: 'Cached Agent',
        capabilities: ['read:data'],
        observationTier: 'GRAY_BOX',
      };

      const result1 = await facade.admit(agent);
      const result2 = await facade.admit(agent);

      expect(result1).toEqual(result2);
    });

    it('should deny revoked agents', async () => {
      const agent: AgentCredentials = {
        agentId: 'revoked-agent',
        name: 'Revoked Agent',
        capabilities: ['read:data'],
        observationTier: 'WHITE_BOX',
      };

      await facade.admit(agent);
      await facade.revoke(agent.agentId, 'Test revocation');

      const result = await facade.admit(agent);

      expect(result.admitted).toBe(false);
      expect(result.reason).toContain('revoked');
    });
  });

  describe('authorize (Dynamic Trust)', () => {
    const agent: AgentCredentials = {
      agentId: 'auth-test-agent',
      name: 'Auth Test Agent',
      capabilities: ['read:data', 'write:reports'],
      observationTier: 'WHITE_BOX',
    };

    beforeEach(async () => {
      await facade.admit(agent);
    });

    it('should authorize allowed actions', async () => {
      const action: Action = {
        type: 'read',
        resource: 'data/users',
      };

      const result = await facade.authorize(agent.agentId, action);

      expect(result.allowed).toBe(true);
      expect(result.tier).toBe('GREEN');
      expect(result.latencyMs).toBeDefined();
    });

    it('should deny actions without capability', async () => {
      const action: Action = {
        type: 'delete',
        resource: 'data/users',
      };

      const result = await facade.authorize(agent.agentId, action);

      expect(result.allowed).toBe(false);
      expect(result.tier).toBe('RED');
      expect(result.reason).toContain('capability');
    });

    it('should deny unadmitted agents', async () => {
      const action: Action = {
        type: 'read',
        resource: 'data/users',
      };

      const result = await facade.authorize('unknown-agent', action);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not admitted');
    });

    it('should include constraints in authorization', async () => {
      const action: Action = {
        type: 'read',
        resource: 'data/users',
      };

      const result = await facade.authorize(agent.agentId, action);

      expect(result.constraints).toBeDefined();
      expect(result.constraints?.timeoutMs).toBeGreaterThan(0);
    });
  });

  describe('fullCheck', () => {
    it('should combine admission and authorization', async () => {
      const agent: AgentCredentials = {
        agentId: 'full-check-agent',
        name: 'Full Check Agent',
        capabilities: ['read:data'],
        observationTier: 'WHITE_BOX',
      };

      const action: Action = {
        type: 'read',
        resource: 'data/users',
      };

      const result = await facade.fullCheck(agent, action);

      expect(result.admission.admitted).toBe(true);
      expect(result.authorization).toBeDefined();
      expect(result.authorization?.allowed).toBe(true);
    });

    it('should not authorize if admission fails', async () => {
      const agent: AgentCredentials = {
        agentId: 'denied-agent',
        name: 'Denied Agent',
        capabilities: ['read:data'],
        observationTier: 'WHITE_BOX',
      };

      await facade.revoke(agent.agentId, 'Pre-revoked');

      const action: Action = {
        type: 'read',
        resource: 'data/users',
      };

      const result = await facade.fullCheck(agent, action);

      expect(result.admission.admitted).toBe(false);
      expect(result.authorization).toBeUndefined();
    });
  });

  describe('recordSignal', () => {
    const agent: AgentCredentials = {
      agentId: 'signal-test-agent',
      name: 'Signal Test Agent',
      capabilities: ['read:data'],
      observationTier: 'WHITE_BOX',
    };

    beforeEach(async () => {
      await facade.admit(agent);
    });

    it('should increase score on success signal', async () => {
      const initialScore = await facade.getScore(agent.agentId);

      await facade.recordSignal({
        agentId: agent.agentId,
        type: 'success',
        weight: 1.0,
        source: 'test',
      });

      const newScore = await facade.getScore(agent.agentId);

      expect(newScore).toBeGreaterThan(initialScore!);
    });

    it('should decrease score on failure signal', async () => {
      const initialScore = await facade.getScore(agent.agentId);

      await facade.recordSignal({
        agentId: agent.agentId,
        type: 'failure',
        weight: 1.0,
        source: 'test',
      });

      const newScore = await facade.getScore(agent.agentId);

      expect(newScore).toBeLessThan(initialScore!);
    });

    it('should apply asymmetric penalties (loss > gain)', async () => {
      // Record a success
      await facade.recordSignal({
        agentId: agent.agentId,
        type: 'success',
        weight: 1.0,
        source: 'test',
      });
      const afterSuccess = await facade.getScore(agent.agentId);

      // Record a failure
      await facade.recordSignal({
        agentId: agent.agentId,
        type: 'failure',
        weight: 1.0,
        source: 'test',
      });
      const afterFailure = await facade.getScore(agent.agentId);

      // Admission gives ~300, success adds small amount, failure subtracts large amount
      const initialScore = 300; // WHITE_BOX initial
      const successGain = afterSuccess! - initialScore;
      const failureLoss = afterSuccess! - afterFailure!;

      // Loss should be significantly greater than gain (asymmetric)
      expect(failureLoss).toBeGreaterThan(successGain * 5);
    });

    it('should respect observation ceiling', async () => {
      // Record many successes
      for (let i = 0; i < 100; i++) {
        await facade.recordSignal({
          agentId: agent.agentId,
          type: 'success',
          weight: 1.0,
          source: 'test',
        });
      }

      const score = await facade.getScore(agent.agentId);

      // WHITE_BOX ceiling is 1000
      expect(score).toBeLessThanOrEqual(1000);
    });
  });

  describe('getScore and getTier', () => {
    it('should return null for unknown agents', async () => {
      const score = await facade.getScore('unknown');
      const tier = await facade.getTier('unknown');

      expect(score).toBeNull();
      expect(tier).toBeNull();
    });

    it('should return correct tier for score', async () => {
      const agent: AgentCredentials = {
        agentId: 'tier-test-agent',
        name: 'Tier Test Agent',
        capabilities: ['read:data'],
        observationTier: 'WHITE_BOX',
      };

      await facade.admit(agent);

      const score = await facade.getScore(agent.agentId);
      const tier = await facade.getTier(agent.agentId);

      // WHITE_BOX starts at 300, which is T1 (200-349)
      expect(score).toBe(300);
      expect(tier).toBe(1);
    });
  });

  describe('revoke', () => {
    it('should prevent future authorizations', async () => {
      const agent: AgentCredentials = {
        agentId: 'revoke-test-agent',
        name: 'Revoke Test Agent',
        capabilities: ['read:data'],
        observationTier: 'WHITE_BOX',
      };

      await facade.admit(agent);
      await facade.revoke(agent.agentId, 'Test revocation');

      const result = await facade.authorize(agent.agentId, {
        type: 'read',
        resource: 'data/users',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('revoked');
    });

    it('should clear score and cache', async () => {
      const agent: AgentCredentials = {
        agentId: 'clear-test-agent',
        name: 'Clear Test Agent',
        capabilities: ['read:data'],
        observationTier: 'WHITE_BOX',
      };

      await facade.admit(agent);
      expect(await facade.getScore(agent.agentId)).not.toBeNull();

      await facade.revoke(agent.agentId, 'Test revocation');

      expect(await facade.getScore(agent.agentId)).toBeNull();
    });
  });
});
