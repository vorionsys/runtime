/**
 * Continuous Trust Validator
 *
 * Detects trust score drift by analyzing recent signal patterns.
 * Identifies agents whose trust tier may need downward adjustment
 * based on a sliding window of negative vs positive signals.
 *
 * @packageDocumentation
 */

import type { SQLiteTrustStore } from './sqlite-trust-store.js';

/**
 * A detected trust drift for a single agent
 */
export interface DriftDetection {
  /** Agent whose trust is drifting */
  agentId: string;
  /** Current trust tier */
  currentTier: number;
  /** Suggested (lower) trust tier */
  suggestedTier: number;
  /** Human-readable explanation */
  reason: string;
  /** Count of negative signals in the window */
  recentNegativeSignals: number;
  /** Count of positive signals in the window */
  recentPositiveSignals: number;
}

/**
 * Scans active agents within a tenant for trust score drift.
 *
 * An agent is flagged when negative signals (failure + violation) outweigh
 * positive signals (success) by at least 2:1 and there are at least 3
 * negative signals within the analysis window.
 *
 * Usage:
 * ```ts
 * const validator = new ContinuousTrustValidator(trustStore);
 * const drifts = await validator.detectDrift('acme-corp', 7);
 * for (const d of drifts) {
 *   console.log(`${d.agentId}: T${d.currentTier} -> T${d.suggestedTier} (${d.reason})`);
 * }
 * ```
 */
export class ContinuousTrustValidator {
  constructor(private trustStore: SQLiteTrustStore) {}

  /**
   * Detect agents with trust drift in the given tenant.
   *
   * @param tenantId - Tenant to scan
   * @param windowDays - Number of days to look back (default 7)
   * @returns Array of drift detections (empty if no drift found)
   */
  async detectDrift(tenantId: string, windowDays: number = 7): Promise<DriftDetection[]> {
    const agents = await this.trustStore.listActiveAgents(tenantId);
    const drifts: DriftDetection[] = [];
    const cutoff = new Date(Date.now() - windowDays * 86_400_000);

    for (const agent of agents) {
      const signals = await this.trustStore.getSignals(
        agent.agentId,
        { since: cutoff },
        tenantId,
      );

      const negative = signals.filter(
        (s) => s.type === 'failure' || s.type === 'violation',
      ).length;

      const positive = signals.filter((s) => s.type === 'success').length;

      // Flag drift when negatives outweigh positives by 2:1 with minimum threshold
      if (negative > positive * 2 && negative >= 3) {
        const suggestedTier = Math.max(0, agent.tier - 1);
        drifts.push({
          agentId: agent.agentId,
          currentTier: agent.tier,
          suggestedTier,
          reason: `${negative} negative vs ${positive} positive signals in ${windowDays}d window`,
          recentNegativeSignals: negative,
          recentPositiveSignals: positive,
        });
      }
    }

    return drifts;
  }
}
