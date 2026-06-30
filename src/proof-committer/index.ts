// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Vorion LLC

/**
 * ProofCommitter - Zero-Latency Proof System
 *
 * Synchronous hash commitment (<1ms) with async batch processing.
 * Uses Merkle trees for batch integrity and optional Ed25519 signing.
 *
 * @packageDocumentation
 */

import * as crypto from 'node:crypto';
import { createLogger } from '../common/logger.js';
import type {
  ProofEvent,
  ProofCommitment,
  ProofBatch,
  ProofCommitterConfig,
  ProofStore,
} from './types.js';
import { DEFAULT_PROOF_COMMITTER_CONFIG, InMemoryProofStore } from './types.js';

export * from './types.js';

const logger = createLogger({ component: 'proof-committer' });

/**
 * ProofCommitter - Fast synchronous commitment with async persistence
 */
export class ProofCommitter {
  private config: ProofCommitterConfig;
  private buffer: ProofCommitment[] = [];
  private store: ProofStore;
  private flushTimer: NodeJS.Timeout | null = null;
  private privateKey: crypto.KeyObject | null = null;
  private isFlushing = false;
  private pendingFlush: Promise<void> | null = null;

  // Metrics
  private totalCommitments = 0;
  private totalBatches = 0;
  private totalFlushTimeMs = 0;

  constructor(config?: Partial<ProofCommitterConfig>, store?: ProofStore) {
    this.config = { ...DEFAULT_PROOF_COMMITTER_CONFIG, ...config };
    this.store = store ?? new InMemoryProofStore();

    // Load signing key if provided
    if (this.config.enableSigning && this.config.privateKey) {
      try {
        this.privateKey = crypto.createPrivateKey({
          key: Buffer.from(this.config.privateKey, 'base64'),
          format: 'der',
          type: 'pkcs8',
        });
        logger.info('Signing key loaded');
      } catch (error) {
        logger.error({ error }, 'Failed to load signing key');
        throw new Error('Invalid signing key');
      }
    }

    // Start flush timer
    this.startFlushTimer();

    logger.info({ config: this.config }, 'ProofCommitter initialized');
  }

  /**
   * Commit an event - MUST complete in <1ms
   *
   * This is the HOT PATH - synchronous, fast
   */
  commit(event: ProofEvent): string {
    const startTime = performance.now();

    // Normalize the timestamp to an integer epoch-ms BEFORE hashing or storing.
    // Two round-trip hazards motivate this:
    //   1. The persistent store keeps a single timestamp column and rebuilds
    //      event.timestamp from it on read, so commitment.timestamp and
    //      event.timestamp must be the same value (one source of truth).
    //   2. That column has INTEGER affinity. A non-numeric value (e.g. an ISO
    //      string like "2026-05-31T...Z", which some callers pass despite the
    //      `number` type) is silently coerced by SQLite to a truncated integer
    //      (2026), so the value read back no longer matches what was hashed and
    //      verifyCommitment falsely reports PROOF_TAMPER_DETECTED.
    // Coercing to a number here makes the hashed value and the stored value
    // identical and stable across the round-trip.
    const rawTimestamp: unknown = event.timestamp;
    const timestamp =
      typeof rawTimestamp === 'number'
        ? rawTimestamp
        : typeof rawTimestamp === 'string' && Number.isFinite(Date.parse(rawTimestamp))
          ? Date.parse(rawTimestamp)
          : Date.now();
    const canonicalEvent: ProofEvent = { ...event, timestamp };

    const commitment: ProofCommitment = {
      id: crypto.randomUUID(),
      hash: this.fastHash(canonicalEvent),
      timestamp,
      event: canonicalEvent,
      tenantId: event.tenantId,
    };

    this.buffer.push(commitment);
    this.totalCommitments++;

    // Trigger async flush if buffer full
    if (this.buffer.length >= this.config.maxBufferSize) {
      setImmediate(() => this.flush());
    }

    const latencyMs = performance.now() - startTime;

    // Warn if we exceeded 1ms
    if (latencyMs > 1) {
      logger.warn({ latencyMs, commitmentId: commitment.id }, 'Commitment exceeded 1ms target');
    }

    return commitment.id;
  }

  /**
   * Fast hash - SHA-256, no signing, ~0.1ms
   *
   * Hashes a CANONICAL projection of the event — a fixed field set in a fixed
   * key order — rather than `JSON.stringify(event)` directly. This makes the
   * hash stable across persistence round-trips: stores (e.g. SQLite) decompose
   * the event into typed columns and reconstruct it on read, which can reorder
   * keys or drop non-persisted fields (such as `tenantId`, which is tracked in
   * its own column). Hashing the raw object made `verifyCommitment` fail after
   * a round-trip and falsely report tampering. The canonical form covers the
   * substantive event content (type, entity, payload, timestamp, correlation).
   */
  private fastHash(event: ProofEvent): string {
    const canonical = JSON.stringify({
      type: event.type,
      entityId: event.entityId,
      payload: event.payload,
      timestamp: event.timestamp,
      correlationId: event.correlationId ?? null,
    });
    const hash = crypto.createHash('sha256');
    hash.update(canonical);
    return hash.digest('hex');
  }

  /**
   * Flush buffer to proof store (COLD PATH - async)
   */
  async flush(): Promise<void> {
    // Prevent concurrent flushes
    if (this.isFlushing) {
      return this.pendingFlush ?? Promise.resolve();
    }

    if (this.buffer.length === 0) {
      return;
    }

    this.isFlushing = true;
    const startTime = performance.now();

    // Take current buffer and reset
    const batch = this.buffer.splice(0, this.buffer.length);

    this.pendingFlush = (async () => {
      try {
        // Build Merkle tree
        const merkleRoot = this.buildMerkleRoot(batch.map((c) => c.hash));

        // Sign if enabled
        const signature = this.sign(merkleRoot);

        // Create batch — propagate tenantId from first commitment
        const proofBatch: ProofBatch = {
          batchId: crypto.randomUUID(),
          merkleRoot,
          signature,
          commitments: batch,
          createdAt: new Date(),
          eventCount: batch.length,
          tenantId: batch[0]?.tenantId,
        };

        // Persist to store
        await this.store.writeBatch(proofBatch);

        this.totalBatches++;
        const flushTimeMs = performance.now() - startTime;
        this.totalFlushTimeMs += flushTimeMs;

        logger.debug(
          {
            batchId: proofBatch.batchId,
            eventCount: batch.length,
            merkleRoot: merkleRoot.substring(0, 16) + '...',
            flushTimeMs,
          },
          'Batch flushed'
        );
      } catch (error) {
        // On error, put events back in buffer (don't lose them)
        this.buffer.unshift(...batch);
        logger.error({ error, eventCount: batch.length }, 'Flush failed, events returned to buffer');
        throw error;
      } finally {
        this.isFlushing = false;
        this.pendingFlush = null;
      }
    })();

    return this.pendingFlush;
  }

  /**
   * Build Merkle root from hashes
   */
  private buildMerkleRoot(hashes: string[]): string {
    if (hashes.length === 0) {
      return '0'.repeat(64);
    }

    if (hashes.length === 1) {
      return hashes[0]!;
    }

    // Pad to even number
    const leaves = [...hashes];
    if (leaves.length % 2 !== 0) {
      leaves.push(leaves[leaves.length - 1]!);
    }

    // Build tree bottom-up
    while (leaves.length > 1) {
      const newLevel: string[] = [];
      for (let i = 0; i < leaves.length; i += 2) {
        const left = leaves[i]!;
        const right = leaves[i + 1] ?? left;
        const combined = crypto.createHash('sha256').update(left + right).digest('hex');
        newLevel.push(combined);
      }
      leaves.length = 0;
      leaves.push(...newLevel);
    }

    return leaves[0]!;
  }

  /**
   * Sign data with Ed25519 (if enabled)
   */
  private sign(data: string): string {
    if (!this.privateKey) {
      return '';
    }

    const signature = crypto.sign(null, Buffer.from(data), this.privateKey);
    return signature.toString('base64');
  }

  /**
   * Start periodic flush timer
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      if (this.buffer.length > 0) {
        this.flush().catch((error) => {
          logger.error({ error }, 'Periodic flush failed');
        });
      }
    }, this.config.flushIntervalMs);

    // Don't block process exit
    this.flushTimer.unref();
  }

  /**
   * Stop the committer (flush remaining and cleanup)
   */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Final flush
    await this.flush();

    logger.info(
      {
        totalCommitments: this.totalCommitments,
        totalBatches: this.totalBatches,
        avgFlushTimeMs: this.totalBatches > 0 ? this.totalFlushTimeMs / this.totalBatches : 0,
      },
      'ProofCommitter stopped'
    );
  }

  /**
   * Get current buffer size
   */
  getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Get metrics
   */
  getMetrics(): {
    totalCommitments: number;
    totalBatches: number;
    avgFlushTimeMs: number;
    bufferSize: number;
  } {
    return {
      totalCommitments: this.totalCommitments,
      totalBatches: this.totalBatches,
      avgFlushTimeMs: this.totalBatches > 0 ? this.totalFlushTimeMs / this.totalBatches : 0,
      bufferSize: this.buffer.length,
    };
  }

  /**
   * Get commitment by ID (from store)
   */
  async getCommitment(commitmentId: string): Promise<ProofCommitment | null> {
    return this.store.getCommitment(commitmentId);
  }

  /**
   * Get all commitments for an entity
   */
  async getCommitmentsForEntity(entityId: string): Promise<ProofCommitment[]> {
    return this.store.getCommitmentsForEntity(entityId);
  }

  /**
   * Verify a commitment's hash
   */
  verifyCommitment(commitment: ProofCommitment): boolean {
    const expectedHash = this.fastHash(commitment.event);
    return commitment.hash === expectedHash;
  }
}

/**
 * Create a new ProofCommitter instance
 */
export function createProofCommitter(
  config?: Partial<ProofCommitterConfig>,
  store?: ProofStore
): ProofCommitter {
  return new ProofCommitter(config, store);
}
