/**
 * Data Retention Manager
 *
 * Enforces tenant-scoped retention policies for trust signals and proof batches.
 * Deletes expired data based on configurable per-tenant retention windows.
 *
 * @packageDocumentation
 */

import type { SQLiteTrustStore } from './sqlite-trust-store.js';
import type { SQLiteProofStore } from './sqlite-proof-store.js';

/**
 * Per-tenant retention policy
 */
export interface RetentionPolicy {
  /** Tenant to apply the policy to */
  tenantId: string;
  /** Number of days to retain proof batches */
  proofRetentionDays: number;
  /** Number of days to retain trust signals */
  signalRetentionDays: number;
}

/**
 * Result of a retention enforcement run
 */
export interface RetentionResult {
  /** Number of trust signals deleted */
  signalsDeleted: number;
  /** Number of proof batches deleted */
  proofsDeleted: number;
  /** When the retention was executed */
  executedAt: Date;
}

/**
 * Enforces data retention policies across trust and proof stores.
 *
 * Usage:
 * ```ts
 * const manager = new RetentionManager(trustStore, proofStore);
 * const result = await manager.enforceRetention({
 *   tenantId: 'acme-corp',
 *   proofRetentionDays: 90,
 *   signalRetentionDays: 30,
 * });
 * ```
 */
export class RetentionManager {
  constructor(
    private trustStore: SQLiteTrustStore,
    private proofStore: SQLiteProofStore,
  ) {}

  /**
   * Enforce a retention policy for a single tenant.
   *
   * Deletes trust signals older than `signalRetentionDays` and
   * proof batches (with their commitments) older than `proofRetentionDays`.
   */
  async enforceRetention(policy: RetentionPolicy): Promise<RetentionResult> {
    const cutoffSignals = new Date(Date.now() - policy.signalRetentionDays * 86_400_000);
    const cutoffProofs = new Date(Date.now() - policy.proofRetentionDays * 86_400_000);

    const signalsDeleted = await this.trustStore.deleteSignalsBefore(
      policy.tenantId,
      cutoffSignals,
    );

    const proofsDeleted = await this.proofStore.deleteBatchesBefore(
      policy.tenantId,
      cutoffProofs,
    );

    return { signalsDeleted, proofsDeleted, executedAt: new Date() };
  }
}
