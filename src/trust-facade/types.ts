// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Vorion LLC

/**
 * TrustFacade Types
 *
 * Defines the unified trust interface combining Gate Trust (the door)
 * and Dynamic Trust (the handshake).
 *
 * Trust tier constants are imported from @vorionsys/shared-constants
 * (single source of truth for the 8-tier trust model).
 *
 * @packageDocumentation
 */

import {
  TIER_THRESHOLDS,
  scoreToTier as sharedScoreToTier,
} from '@vorionsys/shared-constants';

/**
 * Trust tier levels (T0-T7)
 */
export type TrustTier = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * Trust tier names for display
 * Derived from shared-constants TIER_THRESHOLDS (single source of truth)
 */
export const TRUST_TIER_NAMES: Record<TrustTier, string> = Object.fromEntries(
  Object.entries(TIER_THRESHOLDS).map(([k, v]) => [Number(k), (v as { name: string }).name])
) as Record<TrustTier, string>;

/**
 * Trust score ranges for each tier
 * Derived from shared-constants TIER_THRESHOLDS (single source of truth)
 */
export const TRUST_TIER_RANGES: Record<TrustTier, { min: number; max: number }> = Object.fromEntries(
  Object.entries(TIER_THRESHOLDS).map(([k, v]) => [Number(k), { min: (v as { min: number; max: number }).min, max: (v as { min: number; max: number }).max }])
) as Record<TrustTier, { min: number; max: number }>;

/**
 * Score-to-tier conversion from shared-constants (single source of truth)
 */
export { sharedScoreToTier };

/**
 * Decision tier for intent processing
 */
export type DecisionTier = 'GREEN' | 'YELLOW' | 'RED';

/**
 * Observation tier for agent visibility
 */
export type ObservationTier = 'BLACK_BOX' | 'GRAY_BOX' | 'WHITE_BOX';

/**
 * Agent credentials for admission
 */
export interface AgentCredentials {
  /** Unique agent identifier */
  agentId: string;
  /** Agent name for display */
  name: string;
  /** Claimed capabilities */
  capabilities: string[];
  /** Observation tier - how visible is the agent's internals */
  observationTier: ObservationTier;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of agent admission (Gate Trust)
 */
export interface AdmissionResult {
  /** Whether the agent was admitted */
  admitted: boolean;
  /** Initial trust tier assigned */
  initialTier: TrustTier;
  /** Initial trust score */
  initialScore: number;
  /** Maximum trust score based on observation tier */
  observationCeiling: number;
  /** Validated capabilities */
  capabilities: string[];
  /** When admission expires (requires re-verification) */
  expiresAt: Date;
  /** Reason for denial if not admitted */
  reason?: string;
}

/**
 * Action to be authorized
 */
export interface Action {
  /** Action type (e.g., 'read', 'write', 'execute', 'delete') */
  type: string;
  /** Resource being acted upon */
  resource: string;
  /** Additional action context */
  context?: Record<string, unknown>;
}

/**
 * Constraints applied to authorized actions
 */
export interface Constraints {
  /** Maximum number of operations */
  maxOperations?: number;
  /** Time limit in milliseconds */
  timeoutMs?: number;
  /** Resource limits */
  resourceLimits?: {
    maxMemoryMb?: number;
    maxCpuPercent?: number;
    maxNetworkRequests?: number;
  };
  /** Allowed resources (allowlist) */
  allowedResources?: string[];
  /** Blocked resources (blocklist) */
  blockedResources?: string[];
}

/**
 * Refinement option for YELLOW decisions
 */
export interface Refinement {
  /** Refinement ID */
  id: string;
  /** Human-readable description */
  description: string;
  /** Modified action if this refinement is chosen */
  modifiedAction: Action;
  /** Constraints that would apply */
  constraints: Constraints;
}

/**
 * Result of action authorization (Dynamic Trust)
 */
export interface AuthorizationResult {
  /** Whether the action is allowed */
  allowed: boolean;
  /** Decision tier */
  tier: DecisionTier;
  /** Current trust score */
  currentScore: number;
  /** Current trust tier */
  currentTier: TrustTier;
  /** Constraints if allowed */
  constraints?: Constraints;
  /** Refinement options if YELLOW */
  refinements?: Refinement[];
  /** Human-readable reason */
  reason: string;
  /** How long authorization took */
  latencyMs: number;
  /** Proof commitment ID */
  proofCommitmentId?: string;
}

/**
 * Combined result for full check (admission + authorization)
 */
export interface FullCheckResult {
  /** Admission result */
  admission: AdmissionResult;
  /** Authorization result (if admitted) */
  authorization?: AuthorizationResult;
}

/**
 * Trust signal for updating dynamic trust
 */
export interface TrustSignal {
  /** Agent ID */
  agentId: string;
  /** Signal type */
  type: 'success' | 'failure' | 'violation' | 'neutral';
  /** Signal weight (0-1) */
  weight: number;
  /** Signal source */
  source: string;
  /** Additional context */
  context?: Record<string, unknown>;
}

/**
 * Behavioral vector data attached to a TrustSignal's context.
 * When present, TrustFacade forwards the signal through ParameSphere
 * for behavioral analysis (drift, anomaly classification, SVD).
 */
export interface BehavioralVectorContext {
  /** Raw behavioral vector */
  vector: Float32Array;
  /** Distance from the agent's behavioral envelope */
  envelopeDistance: number;
  /** Context domain tag (e.g., 'code-gen', 'summarization') */
  contextTag: string;
  /** Token window size at observation time */
  tokenWindow: number;
  /** Session identifier for trajectory tracking */
  sessionId: string;
}

/**
 * Result of ParameSphere behavioral analysis, returned to callers
 * of recordSignal when behavioral data is present.
 */
export interface BehavioralAnalysisResult {
  /** Whether an anomaly was detected */
  isAnomalous: boolean;
  /** Confidence of the classification (0-1) */
  confidence: number;
  /** Recommended action from the temporal classifier */
  recommendedAction: string;
  /** Whether a signal was emitted to the trust bus */
  emitted: boolean;
}

/**
 * Interface for ParameSphere engine integration.
 * Structurally compatible with ParamesphereEngine from paramesphere/engine/.
 * TrustFacade depends on this interface, not the concrete class.
 */
export interface ParamesphereIntegration {
  /** Process a behavioral vector through the full temporal + context + SVD pipeline */
  processBehavioralVector(input: {
    agentId: string;
    sessionId: string;
    vector: Float32Array;
    envelopeDistance: number;
    contextTag: string;
    tokenWindow: number;
    timestamp: number;
  }): {
    classification: {
      isAnomalous: boolean;
      confidence: number;
      recommendedAction: string;
      flagReason: string | null;
    };
    emitted: boolean;
  };

  /** Start the engine (Pass2Worker, etc.) */
  start(): void;

  /** Stop the engine */
  stop(): void;
}

/**
 * Configuration for TrustFacade
 */
export interface TrustFacadeConfig {
  /** Use atsf-core for persistence */
  useAtsfForPersistence: boolean;
  /** Use a3i for trust dynamics (asymmetric updates) */
  useA3iForDynamics: boolean;
  /** Primary source for trust scores */
  primaryScoreSource: 'atsf' | 'a3i';
  /** Cache TTL for gate trust results (ms) */
  gateTrustCacheTtlMs: number;
  /** Maximum authorization latency target (ms) */
  maxAuthorizationLatencyMs: number;
  /**
   * Optional ParameSphere behavioral analysis engine.
   * When provided, trust signals carrying BehavioralVectorContext in
   * their context field are automatically forwarded through ParameSphere.
   * Anomaly classifications generate additional trust signals.
   */
  paramesphereEngine?: ParamesphereIntegration;
}

/**
 * Default configuration
 */
export const DEFAULT_TRUST_FACADE_CONFIG: TrustFacadeConfig = {
  useAtsfForPersistence: true,
  useA3iForDynamics: true,
  primaryScoreSource: 'atsf',
  gateTrustCacheTtlMs: 3600000, // 1 hour
  maxAuthorizationLatencyMs: 50,
};

/**
 * TrustGate interface - The unified trust API
 */
export interface TrustGate {
  /**
   * THE DOOR - Called once at agent registration
   * Can be slow, result is cached
   */
  admit(agent: AgentCredentials): Promise<AdmissionResult>;

  /**
   * THE HANDSHAKE - Called every action
   * Must be fast (<50ms), uses cached gate trust
   */
  authorize(agentId: string, action: Action): Promise<AuthorizationResult>;

  /**
   * Combined check - door + handshake in one call
   * For new/unknown agents
   */
  fullCheck(agent: AgentCredentials, action: Action): Promise<FullCheckResult>;

  /**
   * Record a trust signal (positive or negative)
   */
  recordSignal(signal: TrustSignal): Promise<void>;

  /**
   * Get current trust score for an agent
   */
  getScore(agentId: string): Promise<number | null>;

  /**
   * Get current trust tier for an agent
   */
  getTier(agentId: string): Promise<TrustTier | null>;

  /**
   * Revoke agent admission
   */
  revoke(agentId: string, reason: string): Promise<void>;
}
