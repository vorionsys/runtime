// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Vorion LLC

/**
 * IntentPipeline - Agent Intent Orchestration
 *
 * Wires TrustFacade + ProofCommitter into a unified flow:
 * Intent → Gate Check → Authorization → Execution → Proof
 *
 * @packageDocumentation
 */

import * as crypto from 'node:crypto';
import { createLogger } from '../common/logger.js';
import { TrustFacade, type AgentCredentials, type Action, type TrustSignal } from '../trust-facade/index.js';
import { ProofCommitter, type ProofEvent } from '../proof-committer/index.js';
import type {
  Intent,
  IntentResult,
  PipelineContext,
  IntentPipelineConfig,
  ExecutionHandler,
} from './types.js';
import { DEFAULT_INTENT_PIPELINE_CONFIG } from './types.js';

export * from './types.js';

const logger = createLogger({ component: 'intent-pipeline' });

/**
 * IntentPipeline - Orchestrates the full agent intent lifecycle
 */
export class IntentPipeline {
  private config: IntentPipelineConfig;
  private trustFacade: TrustFacade;
  private proofCommitter: ProofCommitter;
  private executionHandlers: Map<string, ExecutionHandler> = new Map();

  // Metrics
  private totalIntents = 0;
  private allowedIntents = 0;
  private deniedIntents = 0;
  private totalProcessingTimeMs = 0;

  constructor(
    trustFacade: TrustFacade,
    proofCommitter: ProofCommitter,
    config?: Partial<IntentPipelineConfig>
  ) {
    this.trustFacade = trustFacade;
    this.proofCommitter = proofCommitter;
    this.config = { ...DEFAULT_INTENT_PIPELINE_CONFIG, ...config };

    logger.info({ config: this.config }, 'IntentPipeline initialized');
  }

  /**
   * Register an execution handler for an action type
   */
  registerHandler(actionType: string, handler: ExecutionHandler): void {
    this.executionHandlers.set(actionType, handler);
    logger.debug({ actionType }, 'Handler registered');
  }

  /**
   * Submit an intent for processing
   */
  async submit(
    agentCredentials: AgentCredentials,
    action: Action,
    metadata?: Record<string, unknown>
  ): Promise<IntentResult> {
    const startTime = performance.now();
    const correlationId = crypto.randomUUID();

    const intent: Intent = {
      id: crypto.randomUUID(),
      agentId: agentCredentials.agentId,
      action,
      metadata,
      submittedAt: Date.now(),
    };

    const context: PipelineContext = {
      correlationId,
      credentials: agentCredentials,
      startTime,
    };

    this.totalIntents++;

    // Extract tenantId from metadata for proof pipeline isolation
    const tenantId = metadata?.tenantId as string | undefined;

    // Record intent submission
    const submitCommitmentId = this.proofCommitter.commit({
      type: 'intent_submitted',
      entityId: intent.agentId,
      payload: { intentId: intent.id, action },
      timestamp: Date.now(),
      correlationId,
      tenantId,
    });

    if (this.config.verboseLogging) {
      logger.debug({ intentId: intent.id, correlationId }, 'Intent submitted');
    }

    try {
      // Full trust check (gate + authorization)
      const checkResult = await this.trustFacade.fullCheck(agentCredentials, action);

      // Determine if allowed (must be admitted and authorized)
      const admitted = checkResult.admission.admitted;
      const authorized = checkResult.authorization?.allowed ?? false;
      const allowed = admitted && authorized;
      const tier = checkResult.authorization?.tier ?? 'RED';

      // Record decision
      this.proofCommitter.commit({
        type: 'decision_made',
        entityId: intent.agentId,
        payload: {
          intentId: intent.id,
          allowed,
          tier,
          reason: allowed
            ? 'Trust check passed'
            : admitted
              ? checkResult.authorization?.reason ?? 'Authorization denied'
              : checkResult.admission.reason ?? 'Admission denied',
        },
        timestamp: Date.now(),
        correlationId,
        tenantId,
      });

      if (!allowed) {
        this.deniedIntents++;
        const processingTimeMs = performance.now() - startTime;
        this.totalProcessingTimeMs += processingTimeMs;

        const reason = admitted
          ? checkResult.authorization?.reason ?? 'Authorization denied'
          : `Gate denied: ${checkResult.admission.reason ?? 'Admission denied'}`;

        return {
          intentId: intent.id,
          allowed: false,
          tier,
          reason,
          commitmentId: submitCommitmentId,
          processingTimeMs,
        };
      }

      // Execute if handler exists
      const handler = this.executionHandlers.get(action.type);
      if (handler) {
        // Record execution start
        this.proofCommitter.commit({
          type: 'execution_started',
          entityId: intent.agentId,
          payload: { intentId: intent.id, actionType: action.type },
          timestamp: Date.now(),
          correlationId,
          tenantId,
        });

        const execResult = await handler(intent, context);

        // Record execution completion
        this.proofCommitter.commit({
          type: 'execution_completed',
          entityId: intent.agentId,
          payload: {
            intentId: intent.id,
            success: execResult.success,
            error: execResult.error,
          },
          timestamp: Date.now(),
          correlationId,
          tenantId,
        });

        // Auto-record trust signal on execution
        if (this.config.autoRecordSignals) {
          const signal: TrustSignal = {
            agentId: intent.agentId,
            type: execResult.success ? 'success' : 'failure',
            source: 'execution',
            weight: execResult.success ? 0.1 : 0.5, // Asymmetric: failures weighted more (weight is 0-1)
            context: { intentId: intent.id, actionType: action.type },
          };
          await this.trustFacade.recordSignal(signal);
        }

        if (!execResult.success) {
          this.deniedIntents++;
          const processingTimeMs = performance.now() - startTime;
          this.totalProcessingTimeMs += processingTimeMs;

          return {
            intentId: intent.id,
            allowed: true, // Was allowed, but execution failed
            tier,
            reason: `Execution failed: ${execResult.error}`,
            commitmentId: submitCommitmentId,
            processingTimeMs,
          };
        }
      }

      this.allowedIntents++;
      const processingTimeMs = performance.now() - startTime;
      this.totalProcessingTimeMs += processingTimeMs;

      // Convert constraints object to string array for result
      const constraintStrings = checkResult.authorization?.constraints
        ? Object.entries(checkResult.authorization.constraints)
            .filter(([_, v]) => v !== undefined)
            .map(([k, v]) => `${k}:${JSON.stringify(v)}`)
        : undefined;

      return {
        intentId: intent.id,
        allowed: true,
        tier,
        reason: 'Intent processed successfully',
        commitmentId: submitCommitmentId,
        constraints: constraintStrings,
        processingTimeMs,
      };
    } catch (error) {
      const processingTimeMs = performance.now() - startTime;
      this.totalProcessingTimeMs += processingTimeMs;
      this.deniedIntents++;

      logger.error({ error, intentId: intent.id }, 'Intent processing failed');

      return {
        intentId: intent.id,
        allowed: false,
        tier: 'RED',
        reason: `Processing error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        commitmentId: submitCommitmentId,
        processingTimeMs,
      };
    }
  }

  /**
   * Quick authorization check (no execution)
   */
  async check(agentCredentials: AgentCredentials, action: Action): Promise<{
    allowed: boolean;
    tier: string;
    reason: string;
  }> {
    const result = await this.trustFacade.fullCheck(agentCredentials, action);

    const admitted = result.admission.admitted;
    const authorized = result.authorization?.allowed ?? false;
    const allowed = admitted && authorized;

    return {
      allowed,
      tier: result.authorization?.tier ?? 'RED',
      reason: allowed
        ? 'Allowed'
        : admitted
          ? result.authorization?.reason ?? 'Authorization denied'
          : result.admission.reason ?? 'Admission denied',
    };
  }

  /**
   * Get pipeline metrics
   */
  getMetrics(): {
    totalIntents: number;
    allowedIntents: number;
    deniedIntents: number;
    avgProcessingTimeMs: number;
    allowRate: number;
  } {
    return {
      totalIntents: this.totalIntents,
      allowedIntents: this.allowedIntents,
      deniedIntents: this.deniedIntents,
      avgProcessingTimeMs: this.totalIntents > 0 ? this.totalProcessingTimeMs / this.totalIntents : 0,
      allowRate: this.totalIntents > 0 ? this.allowedIntents / this.totalIntents : 0,
    };
  }

  /**
   * Flush all pending proofs
   */
  async flushProofs(): Promise<void> {
    await this.proofCommitter.flush();
  }

  /**
   * Stop the pipeline (cleanup)
   */
  async stop(): Promise<void> {
    await this.proofCommitter.stop();
    logger.info(this.getMetrics(), 'IntentPipeline stopped');
  }
}

/**
 * Create a new IntentPipeline instance
 */
export function createIntentPipeline(
  trustFacade: TrustFacade,
  proofCommitter: ProofCommitter,
  config?: Partial<IntentPipelineConfig>
): IntentPipeline {
  return new IntentPipeline(trustFacade, proofCommitter, config);
}
