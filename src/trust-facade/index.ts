// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Vorion LLC

/**
 * TrustFacade - Unified Trust Interface
 *
 * Combines Gate Trust (the door) and Dynamic Trust (the handshake)
 * into a single, fast decision function.
 *
 * @packageDocumentation
 */

import { createLogger } from '../common/logger.js';
import type {
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
  Constraints,
  ObservationTier,
  ParamesphereIntegration,
  BehavioralVectorContext,
  BehavioralAnalysisResult,
} from './types.js';
import {
  DEFAULT_TRUST_FACADE_CONFIG,
  TRUST_TIER_NAMES,
  sharedScoreToTier,
} from './types.js';

export * from './types.js';

const logger = createLogger({ component: 'trust-facade' });

/**
 * Observation tier ceilings - maximum trust based on visibility
 */
const OBSERVATION_CEILINGS: Record<ObservationTier, number> = {
  BLACK_BOX: 500,   // Can only reach T3 Monitored
  GRAY_BOX: 800,    // Can reach T5 Trusted
  WHITE_BOX: 1000,  // Can reach T7 Autonomous
};

/**
 * Cache entry for gate trust
 */
interface GateTrustCacheEntry {
  admission: AdmissionResult;
  cachedAt: number;
}

/**
 * TrustFacade implementation
 */
export class TrustFacade implements TrustGate {
  private config: TrustFacadeConfig;
  private gateTrustCache: Map<string, GateTrustCacheEntry> = new Map();
  private trustScores: Map<string, number> = new Map();
  private revokedAgents: Set<string> = new Set();
  private paramesphereEngine: ParamesphereIntegration | null = null;

  constructor(config?: Partial<TrustFacadeConfig>) {
    this.config = { ...DEFAULT_TRUST_FACADE_CONFIG, ...config };

    if (config?.paramesphereEngine) {
      this.paramesphereEngine = config.paramesphereEngine;
      logger.info('ParameSphere behavioral analysis engine attached');
    }

    logger.info({ config: this.config }, 'TrustFacade initialized');
  }

  /**
   * THE DOOR - Agent admission
   */
  async admit(agent: AgentCredentials): Promise<AdmissionResult> {
    const startTime = performance.now();

    // Check if revoked
    if (this.revokedAgents.has(agent.agentId)) {
      logger.warn({ agentId: agent.agentId }, 'Admission denied: agent revoked');
      return {
        admitted: false,
        initialTier: 0,
        initialScore: 0,
        observationCeiling: 0,
        capabilities: [],
        expiresAt: new Date(),
        reason: 'Agent has been revoked',
      };
    }

    // Check cache
    const cached = this.gateTrustCache.get(agent.agentId);
    if (cached && Date.now() - cached.cachedAt < this.config.gateTrustCacheTtlMs) {
      logger.debug({ agentId: agent.agentId }, 'Returning cached admission');
      return cached.admission;
    }

    // Calculate observation ceiling
    const observationCeiling = OBSERVATION_CEILINGS[agent.observationTier];

    // Validate capabilities (stub - would check against registry)
    const validatedCapabilities = this.validateCapabilities(agent.capabilities);

    // Determine initial tier based on observation tier
    const initialScore = this.calculateInitialScore(agent);
    const initialTier = this.scoreToTier(initialScore);

    // Calculate expiration (re-verify in 24 hours)
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const admission: AdmissionResult = {
      admitted: true,
      initialTier,
      initialScore,
      observationCeiling,
      capabilities: validatedCapabilities,
      expiresAt,
    };

    // Cache the result
    this.gateTrustCache.set(agent.agentId, {
      admission,
      cachedAt: Date.now(),
    });

    // Store initial score
    this.trustScores.set(agent.agentId, initialScore);

    const latencyMs = performance.now() - startTime;
    logger.info(
      {
        agentId: agent.agentId,
        initialTier,
        initialScore,
        observationCeiling,
        latencyMs,
      },
      'Agent admitted'
    );

    return admission;
  }

  /**
   * THE HANDSHAKE - Action authorization
   */
  async authorize(agentId: string, action: Action): Promise<AuthorizationResult> {
    const startTime = performance.now();

    // Check if revoked
    if (this.revokedAgents.has(agentId)) {
      return this.createDenialResult(agentId, 'Agent has been revoked', startTime);
    }

    // Check if admitted (has cached gate trust)
    const cached = this.gateTrustCache.get(agentId);
    if (!cached) {
      return this.createDenialResult(agentId, 'Agent not admitted', startTime);
    }

    // Check if admission expired
    if (new Date() > cached.admission.expiresAt) {
      this.gateTrustCache.delete(agentId);
      return this.createDenialResult(agentId, 'Admission expired', startTime);
    }

    // Get current trust score
    const currentScore = this.trustScores.get(agentId) ?? cached.admission.initialScore;
    const currentTier = this.scoreToTier(currentScore);

    // Evaluate the action against trust level
    const decision = this.evaluateAction(action, currentTier, currentScore, cached.admission);

    const latencyMs = performance.now() - startTime;

    // Log if we exceeded latency target
    if (latencyMs > this.config.maxAuthorizationLatencyMs) {
      logger.warn(
        { agentId, latencyMs, target: this.config.maxAuthorizationLatencyMs },
        'Authorization exceeded latency target'
      );
    }

    const result: AuthorizationResult = {
      ...decision,
      currentScore,
      currentTier,
      latencyMs,
    };

    logger.debug(
      {
        agentId,
        action: action.type,
        resource: action.resource,
        tier: result.tier,
        allowed: result.allowed,
        latencyMs,
      },
      'Authorization complete'
    );

    return result;
  }

  /**
   * Combined admission + authorization
   */
  async fullCheck(agent: AgentCredentials, action: Action): Promise<FullCheckResult> {
    const admission = await this.admit(agent);

    if (!admission.admitted) {
      return { admission };
    }

    const authorization = await this.authorize(agent.agentId, action);

    return { admission, authorization };
  }

  /**
   * Record a trust signal
   */
  async recordSignal(signal: TrustSignal): Promise<void> {
    const currentScore = this.trustScores.get(signal.agentId);
    if (currentScore === undefined) {
      logger.warn({ agentId: signal.agentId }, 'Cannot record signal: agent not found');
      return;
    }

    // Get observation ceiling
    const cached = this.gateTrustCache.get(signal.agentId);
    const ceiling = cached?.admission.observationCeiling ?? 1000;

    // Apply asymmetric trust dynamics (10:1 loss:gain ratio)
    let delta: number;
    switch (signal.type) {
      case 'success':
        // Logarithmic gain: small increments
        delta = Math.log(1 + signal.weight * 10) * 2;
        break;
      case 'failure': {
        // Tier-scaled penalty: lower tiers are more lenient to aid ascension.
        // T0=2× ... T4=7× ... T5/T6/T7=10×
        const TIER_FAILURE_MULTS = [2, 3, 4, 5, 7, 10, 10, 10];
        const currentTier = this.scoreToTier(currentScore);
        const tierMult = TIER_FAILURE_MULTS[currentTier] ?? 2;
        delta = -(signal.weight * 50 * tierMult);
        break;
      }
      case 'violation':
        // Severe penalty for violations
        delta = -(signal.weight * 100);
        break;
      case 'neutral':
      default:
        delta = 0;
    }

    // Calculate new score with ceiling
    const newScore = Math.max(0, Math.min(ceiling, currentScore + delta));
    this.trustScores.set(signal.agentId, newScore);

    const oldTier = this.scoreToTier(currentScore);
    const newTier = this.scoreToTier(newScore);

    logger.info(
      {
        agentId: signal.agentId,
        signalType: signal.type,
        weight: signal.weight,
        delta,
        oldScore: currentScore,
        newScore,
        tierChange: oldTier !== newTier ? `T${oldTier} -> T${newTier}` : null,
      },
      'Trust signal recorded'
    );

    // --- ParameSphere behavioral analysis integration ---
    // If the engine is attached and the signal carries behavioral vector data,
    // forward it through ParameSphere for drift/anomaly analysis.
    // Skip signals originating from ParameSphere to prevent infinite recursion.
    const isParamesphereSource = signal.source.startsWith('paramesphere:');
    if (this.paramesphereEngine && signal.context && !isParamesphereSource) {
      const behavioralResult = this.processParamesphereBehavior(signal);
      if (behavioralResult) {
        logger.debug(
          {
            agentId: signal.agentId,
            isAnomalous: behavioralResult.isAnomalous,
            confidence: behavioralResult.confidence,
            recommendedAction: behavioralResult.recommendedAction,
          },
          'ParameSphere behavioral analysis complete'
        );
      }
    }
  }

  /**
   * Get current trust score
   */
  async getScore(agentId: string): Promise<number | null> {
    return this.trustScores.get(agentId) ?? null;
  }

  /**
   * Get current trust tier
   */
  async getTier(agentId: string): Promise<TrustTier | null> {
    const score = this.trustScores.get(agentId);
    if (score === undefined) return null;
    return this.scoreToTier(score);
  }

  /**
   * Revoke agent admission (implements TrustGate interface)
   */
  async revoke(agentId: string, reason: string): Promise<void> {
    this.revokedAgents.add(agentId);
    this.gateTrustCache.delete(agentId);
    this.trustScores.delete(agentId);

    logger.warn({ agentId, reason }, 'Agent revoked');
  }

  /**
   * Alias for revoke (synchronous version for convenience)
   */
  revokeAgent(agentId: string, reason: string): void {
    this.revokedAgents.add(agentId);
    this.gateTrustCache.delete(agentId);
    this.trustScores.delete(agentId);

    logger.warn({ agentId, reason }, 'Agent revoked');
  }

  /**
   * Get combined trust info for an agent
   */
  getAgentTrustInfo(agentId: string): { score: number; tier: TrustTier; ceiling: number } | null {
    const score = this.trustScores.get(agentId);
    if (score === undefined) return null;

    const cached = this.gateTrustCache.get(agentId);
    const ceiling = cached?.admission.observationCeiling ?? 1000;

    return {
      score,
      tier: this.scoreToTier(score),
      ceiling,
    };
  }

  // ============================================================
  // ParameSphere integration
  // ============================================================

  /**
   * Extract BehavioralVectorContext from a TrustSignal's context field.
   * Returns null if the required fields are not present.
   */
  private extractBehavioralContext(context: Record<string, unknown>): BehavioralVectorContext | null {
    const { vector, envelopeDistance, contextTag, tokenWindow, sessionId } = context;

    if (
      !(vector instanceof Float32Array) ||
      typeof envelopeDistance !== 'number' ||
      typeof contextTag !== 'string' ||
      typeof tokenWindow !== 'number' ||
      typeof sessionId !== 'string'
    ) {
      return null;
    }

    return { vector, envelopeDistance, contextTag, tokenWindow, sessionId };
  }

  /**
   * Forward a trust signal through ParameSphere's behavioral analysis pipeline.
   * If anomalies are detected, generates additional trust signals automatically.
   *
   * Returns the analysis result, or null if the signal lacks behavioral data.
   */
  private processParamesphereBehavior(signal: TrustSignal): BehavioralAnalysisResult | null {
    if (!this.paramesphereEngine || !signal.context) return null;

    const behavioral = this.extractBehavioralContext(signal.context);
    if (!behavioral) return null;

    const result = this.paramesphereEngine.processBehavioralVector({
      agentId: signal.agentId,
      sessionId: behavioral.sessionId,
      vector: behavioral.vector,
      envelopeDistance: behavioral.envelopeDistance,
      contextTag: behavioral.contextTag,
      tokenWindow: behavioral.tokenWindow,
      timestamp: Date.now(),
    });

    // If ParameSphere detected an anomaly that wasn't already emitted through
    // the TrustBusAdapter, generate an additional trust signal.
    // This catches anomalies that the engine classified but didn't emit
    // (e.g., below the emitOnMonitor threshold).
    if (result.classification.isAnomalous && !result.emitted) {
      const anomalySignal: TrustSignal = {
        agentId: signal.agentId,
        type: result.classification.recommendedAction === 'HALT' ? 'violation' : 'failure',
        weight: result.classification.confidence,
        source: 'paramesphere:behavioral',
        context: {
          originalSignalSource: signal.source,
          recommendedAction: result.classification.recommendedAction,
          flagReason: result.classification.flagReason,
          sessionId: behavioral.sessionId,
        },
      };

      // Record the anomaly signal — but guard against infinite recursion
      // by checking the source. ParameSphere-originated signals are not
      // re-forwarded through ParameSphere.
      this.recordParamesphereSignal(anomalySignal);
    }

    return {
      isAnomalous: result.classification.isAnomalous,
      confidence: result.classification.confidence,
      recommendedAction: result.classification.recommendedAction,
      emitted: result.emitted,
    };
  }

  /**
   * Record a trust signal generated by ParameSphere behavioral analysis.
   * This is separated from recordSignal to prevent infinite recursion —
   * signals from 'paramesphere:*' sources skip the behavioral analysis hook.
   */
  private async recordParamesphereSignal(signal: TrustSignal): Promise<void> {
    const currentScore = this.trustScores.get(signal.agentId);
    if (currentScore === undefined) return;

    const cached = this.gateTrustCache.get(signal.agentId);
    const ceiling = cached?.admission.observationCeiling ?? 1000;

    let delta: number;
    switch (signal.type) {
      case 'failure': {
        const TIER_FAILURE_MULTS = [2, 3, 4, 5, 7, 10, 10, 10];
        const currentTier = this.scoreToTier(currentScore);
        const tierMult = TIER_FAILURE_MULTS[currentTier] ?? 2;
        delta = -(signal.weight * 50 * tierMult);
        break;
      }
      case 'violation':
        delta = -(signal.weight * 100);
        break;
      default:
        delta = 0;
    }

    const newScore = Math.max(0, Math.min(ceiling, currentScore + delta));
    this.trustScores.set(signal.agentId, newScore);

    const oldTier = this.scoreToTier(currentScore);
    const newTier = this.scoreToTier(newScore);

    logger.info(
      {
        agentId: signal.agentId,
        signalType: signal.type,
        weight: signal.weight,
        delta,
        oldScore: currentScore,
        newScore,
        tierChange: oldTier !== newTier ? `T${oldTier} -> T${newTier}` : null,
        source: signal.source,
      },
      'ParameSphere anomaly signal recorded'
    );
  }

  // ============================================================
  // Private methods
  // ============================================================

  private validateCapabilities(capabilities?: string[]): string[] {
    // Stub - would validate against capability registry
    if (!capabilities) {
      return [];
    }
    return capabilities.filter((cap) => !cap.includes('admin'));
  }

  private calculateInitialScore(agent: AgentCredentials): number {
    // Initial score based on observation tier
    switch (agent.observationTier) {
      case 'WHITE_BOX':
        return 300; // Start at T1
      case 'GRAY_BOX':
        return 200; // Start at T1
      case 'BLACK_BOX':
      default:
        return 100; // Start at T0
    }
  }

  private scoreToTier(score: number): TrustTier {
    return sharedScoreToTier(Math.max(0, Math.min(1000, score))) as TrustTier;
  }

  private evaluateAction(
    action: Action,
    tier: TrustTier,
    score: number,
    admission: AdmissionResult
  ): Omit<AuthorizationResult, 'currentScore' | 'currentTier' | 'latencyMs'> {
    // Check capability
    const requiredCapability = `${action.type}:${action.resource.split('/')[0]}`;
    const hasCapability = admission.capabilities.some(
      (cap) => cap === requiredCapability || cap === `${action.type}:*` || cap === '*'
    );

    if (!hasCapability) {
      return {
        allowed: false,
        tier: 'RED',
        reason: `Missing capability: ${requiredCapability}`,
      };
    }

    // Tier-based constraints
    const constraints = this.getConstraintsForTier(tier);

    // Determine decision tier based on action risk
    const actionRisk = this.assessActionRisk(action);

    if (actionRisk === 'high' && tier < 4) {
      // High-risk action requires T4+
      return {
        allowed: false,
        tier: 'RED',
        reason: `High-risk action requires T4 (Standard) or higher. Current: T${tier} (${TRUST_TIER_NAMES[tier]})`,
      };
    }

    if (actionRisk === 'medium' && tier < 2) {
      // Medium-risk needs refinement for low-trust agents
      return {
        allowed: true,
        tier: 'YELLOW',
        constraints,
        reason: 'Action requires additional constraints at current trust level',
        refinements: [
          {
            id: 'add-timeout',
            description: 'Execute with shorter timeout',
            modifiedAction: action,
            constraints: { ...constraints, timeoutMs: 30000 },
          },
          {
            id: 'add-approval',
            description: 'Request human approval',
            modifiedAction: action,
            constraints: { ...constraints },
          },
        ],
      };
    }

    // GREEN - allowed with constraints
    return {
      allowed: true,
      tier: 'GREEN',
      constraints,
      reason: `Authorized at T${tier} (${TRUST_TIER_NAMES[tier]})`,
    };
  }

  private getConstraintsForTier(tier: TrustTier): Constraints {
    const baseConstraints: Constraints = {
      timeoutMs: 300000, // 5 minutes
      resourceLimits: {
        maxMemoryMb: 512,
        maxCpuPercent: 50,
      },
    };

    switch (tier) {
      case 0:
      case 1:
        return {
          ...baseConstraints,
          maxOperations: 10,
          timeoutMs: 60000,
          resourceLimits: {
            maxMemoryMb: 128,
            maxCpuPercent: 25,
            maxNetworkRequests: 0, // No network
          },
        };
      case 2:
      case 3:
        return {
          ...baseConstraints,
          maxOperations: 50,
          timeoutMs: 120000,
          resourceLimits: {
            maxMemoryMb: 256,
            maxCpuPercent: 50,
            maxNetworkRequests: 10,
          },
        };
      case 4:
      case 5:
        return {
          ...baseConstraints,
          maxOperations: 200,
          resourceLimits: {
            maxMemoryMb: 512,
            maxCpuPercent: 75,
            maxNetworkRequests: 50,
          },
        };
      case 6:
      case 7:
      default:
        return {
          ...baseConstraints,
          maxOperations: 1000,
          timeoutMs: 600000,
          resourceLimits: {
            maxMemoryMb: 1024,
            maxCpuPercent: 100,
            maxNetworkRequests: undefined, // Unlimited
          },
        };
    }
  }

  private assessActionRisk(action: Action): 'low' | 'medium' | 'high' {
    const highRiskActions = ['delete', 'execute', 'admin'];
    const mediumRiskActions = ['write', 'update', 'create'];

    if (highRiskActions.includes(action.type)) return 'high';
    if (mediumRiskActions.includes(action.type)) return 'medium';
    return 'low';
  }

  private createDenialResult(
    agentId: string,
    reason: string,
    startTime: number
  ): AuthorizationResult {
    return {
      allowed: false,
      tier: 'RED',
      currentScore: 0,
      currentTier: 0,
      reason,
      latencyMs: performance.now() - startTime,
    };
  }
}

/**
 * Create a new TrustFacade instance
 */
export function createTrustFacade(config?: Partial<TrustFacadeConfig>): TrustFacade {
  return new TrustFacade(config);
}
