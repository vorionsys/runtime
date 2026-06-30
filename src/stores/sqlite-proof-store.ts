// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Vorion LLC

/**
 * SQLite Proof Store
 *
 * Persistent storage for proof commitments and batches using SQLite.
 * Supports multi-tenant isolation via tenant_id column.
 *
 * @packageDocumentation
 */

import Database from 'better-sqlite3';
import { createLogger } from '../common/logger.js';
import type { ProofStore, ProofBatch, ProofCommitment, ProofEventType } from '../proof-committer/types.js';

const logger = createLogger({ component: 'sqlite-proof-store' });

/** Default tenant ID for backward compatibility */
const DEFAULT_TENANT_ID = '__default__';

export interface SQLiteProofStoreConfig {
  /** Database file path (use ':memory:' for in-memory) */
  dbPath: string;
  /** Enable WAL mode for better concurrency (default: true) */
  walMode?: boolean;
}

/**
 * SQLite implementation of ProofStore with multi-tenant support
 */
export class SQLiteProofStore implements ProofStore {
  private db: Database.Database;
  private config: SQLiteProofStoreConfig;

  // Prepared statements for performance
  private stmts: {
    insertBatch: Database.Statement;
    insertCommitment: Database.Statement;
    getBatch: Database.Statement;
    getCommitment: Database.Statement;
    getCommitmentsForEntity: Database.Statement;
    getCommitmentsForBatch: Database.Statement;
    deleteBatchesBefore: Database.Statement;
    deleteCommitmentsForBatches: Database.Statement;
    getBatchIdsBefore: Database.Statement;
  } | null = null;

  constructor(config: SQLiteProofStoreConfig) {
    this.config = {
      walMode: true,
      ...config,
    };

    this.db = new Database(this.config.dbPath);

    // Enable WAL mode for better write performance
    if (this.config.walMode) {
      this.db.pragma('journal_mode = WAL');
    }

    this.initializeSchema();
    this.prepareStatements();

    logger.info({ dbPath: this.config.dbPath }, 'SQLite proof store initialized');
  }

  private initializeSchema(): void {
    this.db.exec(`
      -- Batches table with tenant isolation
      CREATE TABLE IF NOT EXISTS proof_batches (
        batch_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}',
        merkle_root TEXT NOT NULL,
        signature TEXT NOT NULL,
        created_at TEXT NOT NULL,
        event_count INTEGER NOT NULL
      );

      -- Commitments table with tenant isolation
      CREATE TABLE IF NOT EXISTS proof_commitments (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}',
        hash TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        batch_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        correlation_id TEXT,
        FOREIGN KEY (batch_id) REFERENCES proof_batches(batch_id)
      );

      -- Tenant indexes
      CREATE INDEX IF NOT EXISTS idx_batches_tenant ON proof_batches(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_commitments_tenant ON proof_commitments(tenant_id);

      -- Composite indexes with tenant_id first
      CREATE INDEX IF NOT EXISTS idx_commitments_tenant_entity_id ON proof_commitments(tenant_id, entity_id);
      CREATE INDEX IF NOT EXISTS idx_commitments_tenant_batch_id ON proof_commitments(tenant_id, batch_id);
      CREATE INDEX IF NOT EXISTS idx_commitments_tenant_timestamp ON proof_commitments(tenant_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_batches_tenant_created_at ON proof_batches(tenant_id, created_at);
    `);

    logger.debug('Database schema initialized');
  }

  private prepareStatements(): void {
    this.stmts = {
      insertBatch: this.db.prepare(`
        INSERT INTO proof_batches (batch_id, tenant_id, merkle_root, signature, created_at, event_count)
        VALUES (@batchId, @tenantId, @merkleRoot, @signature, @createdAt, @eventCount)
      `),

      insertCommitment: this.db.prepare(`
        INSERT INTO proof_commitments (id, tenant_id, hash, timestamp, batch_id, event_type, entity_id, payload, correlation_id)
        VALUES (@id, @tenantId, @hash, @timestamp, @batchId, @eventType, @entityId, @payload, @correlationId)
      `),

      getBatch: this.db.prepare(`
        SELECT batch_id, merkle_root, signature, created_at, event_count
        FROM proof_batches
        WHERE batch_id = ? AND tenant_id = ?
      `),

      getCommitment: this.db.prepare(`
        SELECT id, hash, timestamp, batch_id, event_type, entity_id, payload, correlation_id
        FROM proof_commitments
        WHERE id = ? AND tenant_id = ?
      `),

      getCommitmentsForEntity: this.db.prepare(`
        SELECT id, hash, timestamp, batch_id, event_type, entity_id, payload, correlation_id
        FROM proof_commitments
        WHERE entity_id = ? AND tenant_id = ?
        ORDER BY timestamp DESC
      `),

      getCommitmentsForBatch: this.db.prepare(`
        SELECT id, hash, timestamp, event_type, entity_id, payload, correlation_id
        FROM proof_commitments
        WHERE batch_id = ? AND tenant_id = ?
      `),

      getBatchIdsBefore: this.db.prepare(`
        SELECT batch_id
        FROM proof_batches
        WHERE tenant_id = ? AND created_at < ?
      `),

      deleteCommitmentsForBatches: this.db.prepare(`
        DELETE FROM proof_commitments
        WHERE tenant_id = ? AND batch_id IN (
          SELECT batch_id FROM proof_batches WHERE tenant_id = ? AND created_at < ?
        )
      `),

      deleteBatchesBefore: this.db.prepare(`
        DELETE FROM proof_batches
        WHERE tenant_id = ? AND created_at < ?
      `),
    };
  }

  /**
   * Write a batch to storage
   */
  async writeBatch(batch: ProofBatch, tenantId: string = DEFAULT_TENANT_ID): Promise<void> {
    if (!this.stmts) throw new Error('Store not initialized');

    // Prefer tenantId from batch object (pipeline-propagated), fall back to parameter (backward compat)
    const effectiveTenantId = batch.tenantId ?? tenantId;

    const transaction = this.db.transaction(() => {
      // Insert batch
      this.stmts!.insertBatch.run({
        batchId: batch.batchId,
        tenantId: effectiveTenantId,
        merkleRoot: batch.merkleRoot,
        signature: batch.signature,
        createdAt: batch.createdAt.toISOString(),
        eventCount: batch.eventCount,
      });

      // Insert all commitments — each commitment may carry its own tenantId
      for (const commitment of batch.commitments) {
        this.stmts!.insertCommitment.run({
          id: commitment.id,
          tenantId: commitment.tenantId ?? effectiveTenantId,
          hash: commitment.hash,
          timestamp: commitment.timestamp,
          batchId: batch.batchId,
          eventType: commitment.event.type,
          entityId: commitment.event.entityId,
          payload: JSON.stringify(commitment.event.payload),
          correlationId: commitment.event.correlationId ?? null,
        });
      }
    });

    transaction();

    logger.debug(
      { batchId: batch.batchId, tenantId, commitmentCount: batch.commitments.length },
      'Batch written to SQLite'
    );
  }

  /**
   * Get a batch by ID
   */
  async getBatch(batchId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<ProofBatch | null> {
    if (!this.stmts) throw new Error('Store not initialized');

    const row = this.stmts.getBatch.get(batchId, tenantId) as {
      batch_id: string;
      merkle_root: string;
      signature: string;
      created_at: string;
      event_count: number;
    } | undefined;

    if (!row) return null;

    // Get all commitments for this batch within the same tenant
    const commitmentRows = this.stmts.getCommitmentsForBatch.all(batchId, tenantId) as Array<{
      id: string;
      hash: string;
      timestamp: number;
      event_type: string;
      entity_id: string;
      payload: string;
      correlation_id: string | null;
    }>;

    const commitments: ProofCommitment[] = commitmentRows.map((c) => ({
      id: c.id,
      hash: c.hash,
      timestamp: c.timestamp,
      event: {
        type: c.event_type as ProofEventType,
        entityId: c.entity_id,
        payload: JSON.parse(c.payload),
        timestamp: c.timestamp,
        correlationId: c.correlation_id ?? undefined,
      },
    }));

    return {
      batchId: row.batch_id,
      merkleRoot: row.merkle_root,
      signature: row.signature,
      createdAt: new Date(row.created_at),
      eventCount: row.event_count,
      commitments,
    };
  }

  /**
   * Get commitment by ID
   */
  async getCommitment(commitmentId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<ProofCommitment | null> {
    if (!this.stmts) throw new Error('Store not initialized');

    const row = this.stmts.getCommitment.get(commitmentId, tenantId) as {
      id: string;
      hash: string;
      timestamp: number;
      event_type: string;
      entity_id: string;
      payload: string;
      correlation_id: string | null;
    } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      hash: row.hash,
      timestamp: row.timestamp,
      event: {
        type: row.event_type as ProofEventType,
        entityId: row.entity_id,
        payload: JSON.parse(row.payload),
        timestamp: row.timestamp,
        correlationId: row.correlation_id ?? undefined,
      },
    };
  }

  /**
   * Get all commitments for an entity
   */
  async getCommitmentsForEntity(entityId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<ProofCommitment[]> {
    if (!this.stmts) throw new Error('Store not initialized');

    const rows = this.stmts.getCommitmentsForEntity.all(entityId, tenantId) as Array<{
      id: string;
      hash: string;
      timestamp: number;
      event_type: string;
      entity_id: string;
      payload: string;
      correlation_id: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      hash: row.hash,
      timestamp: row.timestamp,
      event: {
        type: row.event_type as ProofEventType,
        entityId: row.entity_id,
        payload: JSON.parse(row.payload),
        timestamp: row.timestamp,
        correlationId: row.correlation_id ?? undefined,
      },
    }));
  }

  /**
   * Delete batches (and their commitments) created before a cutoff date for a specific tenant.
   * Returns the number of batches deleted.
   */
  async deleteBatchesBefore(tenantId: string, cutoff: Date): Promise<number> {
    if (!this.stmts) throw new Error('Store not initialized');

    const cutoffIso = cutoff.toISOString();

    const transaction = this.db.transaction(() => {
      // Delete commitments belonging to batches that will be removed
      this.stmts!.deleteCommitmentsForBatches.run(tenantId, tenantId, cutoffIso);

      // Delete the batches themselves
      const result = this.stmts!.deleteBatchesBefore.run(tenantId, cutoffIso);
      return result.changes;
    });

    const deleted = transaction();
    logger.info({ tenantId, cutoff: cutoffIso, deleted }, 'Proof batch retention enforced');
    return deleted;
  }

  /**
   * Get statistics
   */
  getStats(): { batches: number; commitments: number } {
    const batchCount = this.db.prepare('SELECT COUNT(*) as count FROM proof_batches').get() as { count: number };
    const commitmentCount = this.db.prepare('SELECT COUNT(*) as count FROM proof_commitments').get() as { count: number };

    return {
      batches: batchCount.count,
      commitments: commitmentCount.count,
    };
  }

  /**
   * Clear all data (useful for testing)
   */
  clear(): void {
    this.db.exec('DELETE FROM proof_commitments');
    this.db.exec('DELETE FROM proof_batches');
    logger.debug('All data cleared');
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
    logger.info('SQLite proof store closed');
  }
}

/**
 * Create a new SQLite proof store
 */
export function createSQLiteProofStore(config: SQLiteProofStoreConfig): SQLiteProofStore {
  return new SQLiteProofStore(config);
}
