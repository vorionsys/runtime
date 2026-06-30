// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Vorion LLC

/**
 * IntentPipeline Types
 *
 * Orchestrates the full agent intent lifecycle:
 * Intent → Gate Check → Authorization → Execution → Proof
 *
 * @packageDocumentation
 */

import type { AgentCredentials, Action, TrustSignal, DecisionTier } from '../trust-facade/index.js';
import type { ProofEvent } from '../proof-committer/index.js';

/**
 * An intent submitted by an agent
 */
export interface Intent {
  /** Unique intent ID */
  id: string;
  /** Agent submitting the intent */
  agentId: string;
  /** The action the agent wants to perform */
  action: Action;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
  /** Submission timestamp */
  submittedAt: number;
}

/**
 * Result of processing an intent through the pipeline
 */
export interface IntentResult {
  /** The intent ID */
  intentId: string;
  /** Whether the intent was allowed */
  allowed: boolean;
  /** Decision tier (GREEN/YELLOW/RED) */
  tier: DecisionTier;
  /** Reason for decision */
  reason: string;
  /** Proof commitment ID */
  commitmentId: string;
  /** Constraints applied (if any) */
  constraints?: string[];
  /** Processing time in ms */
  processingTimeMs: number;
}

/**
 * Pipeline execution context
 */
export interface PipelineContext {
  /** Correlation ID for tracing */
  correlationId: string;
  /** Agent credentials (cached or fresh) */
  credentials: AgentCredentials;
  /** Start time for metrics */
  startTime: number;
}

/**
 * Pipeline configuration
 */
export interface IntentPipelineConfig {
  /** Enable detailed logging */
  verboseLogging: boolean;
  /** Maximum processing time before timeout (ms) */
  timeoutMs: number;
  /** Auto-record signals on execution */
  autoRecordSignals: boolean;
}

/**
 * Default pipeline configuration
 */
export const DEFAULT_INTENT_PIPELINE_CONFIG: IntentPipelineConfig = {
  verboseLogging: false,
  timeoutMs: 5000,
  autoRecordSignals: true,
};

/**
 * Execution handler type
 */
export type ExecutionHandler = (
  intent: Intent,
  context: PipelineContext
) => Promise<{ success: boolean; result?: unknown; error?: string }>;
