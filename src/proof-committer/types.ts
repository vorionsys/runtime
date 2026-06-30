// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Vorion LLC

/**
 * ProofCommitter Types
 *
 * Zero-latency proof design with async batching.
 * Synchronous hash commitment (<1ms) with async batch processing.
 *
 * @packageDocumentation
 */

/**
 * Event types that can be recorded in the proof plane
 */
export type ProofEventType =
  | 'intent_submitted'
  | 'decision_made'
  | 'execution_started'
  | 'execution_completed'
  | 'trust_signal'
  | 'agent_admitted'
  | 'agent_revoked'
  | 'parity_violation';

/**
 * A proof event to be committed
 */
export interface ProofEvent {
  /** Event type */
  type: ProofEventType;
  /** Entity ID (agent, intent, etc.) */
  entityId: string;
  /** Event payload */
  payload: Record<string, unknown>;
  /** Timestamp */
  timestamp: number;
  /** Optional correlation ID for linking events */
  correlationId?: string;
  /** Tenant ID for multi-tenant isolation (optional for backward compatibility) */
  tenantId?: string;
}

/**
 * A commitment in the buffer
 */
export interface ProofCommitment {
  /** Unique commitment ID */
  id: string;
  /** SHA-256 hash of the event */
  hash: string;
  /** Timestamp when committed */
  timestamp: number;
  /** The original event (held until flushed) */
  event: ProofEvent;
  /** Tenant ID for multi-tenant isolation (optional for backward compatibility) */
  tenantId?: string;
}

/**
 * A batch of commitments ready for persistence
 */
export interface ProofBatch {
  /** Unique batch ID */
  batchId: string;
  /** Merkle root of all commitments */
  merkleRoot: string;
  /** Ed25519 signature of merkle root */
  signature: string;
  /** All commitments in this batch */
  commitments: ProofCommitment[];
  /** When batch was created */
  createdAt: Date;
  /** Number of events in batch */
  eventCount: number;
  /** Tenant ID for multi-tenant isolation (optional for backward compatibility) */
  tenantId?: string;
}

/**
 * Configuration for ProofCommitter
 */
export interface ProofCommitterConfig {
  /** Maximum buffer size before auto-flush */
  maxBufferSize: number;
  /** Flush interval in milliseconds */
  flushIntervalMs: number;
  /** Enable signing (requires private key) */
  enableSigning: boolean;
  /** Private key for signing (base64-encoded Ed25519) */
  privateKey?: string;
}

/**
 * Default configuration
 */
export const DEFAULT_PROOF_COMMITTER_CONFIG: ProofCommitterConfig = {
  maxBufferSize: 100,
  flushIntervalMs: 100,
  enableSigning: false,
};

/**
 * Proof store interface for persistence
 */
export interface ProofStore {
  /** Write a batch to storage */
  writeBatch(batch: ProofBatch): Promise<void>;
  /** Get a batch by ID */
  getBatch(batchId: string): Promise<ProofBatch | null>;
  /** Get commitment by ID */
  getCommitment(commitmentId: string): Promise<ProofCommitment | null>;
  /** Get all commitments for an entity */
  getCommitmentsForEntity(entityId: string): Promise<ProofCommitment[]>;
}

/**
 * In-memory proof store for testing/development
 */
export class InMemoryProofStore implements ProofStore {
  private batches: Map<string, ProofBatch> = new Map();
  private commitments: Map<string, ProofCommitment> = new Map();
  private entityIndex: Map<string, string[]> = new Map();

  async writeBatch(batch: ProofBatch): Promise<void> {
    this.batches.set(batch.batchId, batch);

    for (const commitment of batch.commitments) {
      this.commitments.set(commitment.id, commitment);

      // Index by entity
      const entityCommitments = this.entityIndex.get(commitment.event.entityId) ?? [];
      entityCommitments.push(commitment.id);
      this.entityIndex.set(commitment.event.entityId, entityCommitments);
    }
  }

  async getBatch(batchId: string): Promise<ProofBatch | null> {
    return this.batches.get(batchId) ?? null;
  }

  async getCommitment(commitmentId: string): Promise<ProofCommitment | null> {
    return this.commitments.get(commitmentId) ?? null;
  }

  async getCommitmentsForEntity(entityId: string): Promise<ProofCommitment[]> {
    const ids = this.entityIndex.get(entityId) ?? [];
    return ids.map((id) => this.commitments.get(id)!).filter(Boolean);
  }

  /** Get stats for testing */
  getStats(): { batches: number; commitments: number } {
    return {
      batches: this.batches.size,
      commitments: this.commitments.size,
    };
  }

  /** Clear all data */
  clear(): void {
    this.batches.clear();
    this.commitments.clear();
    this.entityIndex.clear();
  }
}
