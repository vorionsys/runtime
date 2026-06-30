// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Vorion LLC

/**
 * @vorionsys/runtime - Vorion Runtime
 *
 * Orchestration layer for AI agent governance.
 * Combines Gate Trust (the door) and Dynamic Trust (the handshake)
 * into a unified, fast decision system.
 *
 * @packageDocumentation
 */

// TrustFacade - The unified trust interface
export {
  TrustFacade,
  createTrustFacade,
  // Types
  type TrustGate,
  type TrustFacadeConfig,
  type AgentCredentials,
  type AdmissionResult,
  type Action,
  type AuthorizationResult,
  type FullCheckResult,
  type TrustSignal,
  type TrustTier,
  type DecisionTier,
  type Constraints,
  type Refinement,
  type ObservationTier,
  // ParameSphere integration types
  type ParamesphereIntegration,
  type BehavioralVectorContext,
  type BehavioralAnalysisResult,
  // Constants
  DEFAULT_TRUST_FACADE_CONFIG,
  TRUST_TIER_NAMES,
  TRUST_TIER_RANGES,
} from './trust-facade/index.js';

// ProofCommitter - Zero-latency proof system
export {
  ProofCommitter,
  createProofCommitter,
  InMemoryProofStore,
  // Types
  type ProofEvent,
  type ProofEventType,
  type ProofCommitment,
  type ProofBatch,
  type ProofCommitterConfig,
  type ProofStore,
  // Constants
  DEFAULT_PROOF_COMMITTER_CONFIG,
} from './proof-committer/index.js';

// IntentPipeline - Orchestrated intent processing
export {
  IntentPipeline,
  createIntentPipeline,
  // Types
  type Intent,
  type IntentResult,
  type PipelineContext,
  type IntentPipelineConfig,
  type ExecutionHandler,
  // Constants
  DEFAULT_INTENT_PIPELINE_CONFIG,
} from './intent-pipeline/index.js';

// Persistent stores
export {
  SQLiteProofStore,
  createSQLiteProofStore,
  type SQLiteProofStoreConfig,
} from './stores/sqlite-proof-store.js';

export {
  SQLiteTrustStore,
  createSQLiteTrustStore,
  type SQLiteTrustStoreConfig,
  type TrustStore,
  type AgentTrustRecord,
  type TrustSignalRecord,
  type GetSignalsOptions,
} from './stores/sqlite-trust-store.js';

// Retention management
export {
  RetentionManager,
  type RetentionPolicy,
  type RetentionResult,
} from './stores/retention-manager.js';

// Continuous trust validation
export {
  ContinuousTrustValidator,
  type DriftDetection,
} from './stores/trust-validator.js';

// Re-export logger for consumers
export { createLogger, type LoggerOptions } from './common/logger.js';
