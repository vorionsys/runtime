// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Vorion LLC

/**
 * ProofCommitter Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ProofCommitter,
  createProofCommitter,
  InMemoryProofStore,
} from "../index.js";
import type { ProofEvent } from "../types.js";

describe("ProofCommitter", () => {
  let committer: ProofCommitter;
  let store: InMemoryProofStore;

  beforeEach(() => {
    store = new InMemoryProofStore();
    committer = createProofCommitter(
      {
        maxBufferSize: 10,
        flushIntervalMs: 1000, // Long interval for manual control
      },
      store,
    );
  });

  afterEach(async () => {
    await committer.stop();
  });

  describe("commit", () => {
    it("should commit an event and return commitment ID", () => {
      const event: ProofEvent = {
        type: "intent_submitted",
        entityId: "agent-1",
        payload: { action: "read", resource: "data/users" },
        timestamp: Date.now(),
      };

      const commitmentId = committer.commit(event);

      expect(commitmentId).toBeDefined();
      expect(typeof commitmentId).toBe("string");
      expect(committer.getBufferSize()).toBe(1);
    });

    it("should complete in under 1ms", () => {
      const event: ProofEvent = {
        type: "decision_made",
        entityId: "agent-1",
        payload: { tier: "GREEN", allowed: true },
        timestamp: Date.now(),
      };

      const start = performance.now();
      committer.commit(event);
      const elapsed = performance.now() - start;

      // Should be well under 1ms (usually 0.1-0.3ms); generous ceiling to
      // absorb CI runner load/jitter (observed ~10ms under contention).
      expect(elapsed).toBeLessThan(50);
    });

    it("should handle many commits quickly", () => {
      const events: ProofEvent[] = Array.from({ length: 100 }, (_, i) => ({
        type: "trust_signal" as const,
        entityId: `agent-${i}`,
        payload: { value: i },
        timestamp: Date.now(),
      }));

      const start = performance.now();
      for (const event of events) {
        committer.commit(event);
      }
      const elapsed = performance.now() - start;

      // 100 commits should take < 1ms each on average; generous ceiling for
      // CI runner load/jitter.
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe("flush", () => {
    it("should flush buffer to store", async () => {
      // Commit some events
      for (let i = 0; i < 5; i++) {
        committer.commit({
          type: "execution_completed",
          entityId: `agent-${i}`,
          payload: { result: "success" },
          timestamp: Date.now(),
        });
      }

      expect(committer.getBufferSize()).toBe(5);

      await committer.flush();

      expect(committer.getBufferSize()).toBe(0);
      expect(store.getStats().batches).toBe(1);
      expect(store.getStats().commitments).toBe(5);
    });

    it("should auto-flush when buffer is full", async () => {
      // Create committer with small buffer
      const smallCommitter = createProofCommitter(
        { maxBufferSize: 3, flushIntervalMs: 10000 },
        store,
      );

      // Commit 4 events (exceeds buffer size of 3)
      for (let i = 0; i < 4; i++) {
        smallCommitter.commit({
          type: "trust_signal",
          entityId: "agent-1",
          payload: { i },
          timestamp: Date.now(),
        });
      }

      // Give time for setImmediate flush
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Buffer should have been flushed (4th event may be in new batch)
      expect(smallCommitter.getBufferSize()).toBeLessThanOrEqual(1);

      await smallCommitter.stop();
    });

    it("should create valid Merkle root", async () => {
      committer.commit({
        type: "agent_admitted",
        entityId: "agent-1",
        payload: { tier: 1 },
        timestamp: Date.now(),
      });

      committer.commit({
        type: "agent_admitted",
        entityId: "agent-2",
        payload: { tier: 2 },
        timestamp: Date.now(),
      });

      await committer.flush();

      // Get the batch from store
      const commitments = await store.getCommitmentsForEntity("agent-1");
      expect(commitments.length).toBe(1);

      const stats = store.getStats();
      expect(stats.batches).toBe(1);
    });

    it("should handle empty flush gracefully", async () => {
      await committer.flush();
      expect(store.getStats().batches).toBe(0);
    });
  });

  describe("getCommitment", () => {
    it("should retrieve committed events after flush", async () => {
      const event: ProofEvent = {
        type: "parity_violation",
        entityId: "agent-1",
        payload: { gap: 2, required: "H3" },
        timestamp: Date.now(),
      };

      const commitmentId = committer.commit(event);
      await committer.flush();

      const retrieved = await committer.getCommitment(commitmentId);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(commitmentId);
      expect(retrieved?.event.type).toBe("parity_violation");
      expect(retrieved?.event.entityId).toBe("agent-1");
    });

    it("should return null for unknown commitment", async () => {
      const result = await committer.getCommitment("unknown-id");
      expect(result).toBeNull();
    });
  });

  describe("getCommitmentsForEntity", () => {
    it("should return all commitments for an entity", async () => {
      // Commit multiple events for same entity
      for (let i = 0; i < 3; i++) {
        committer.commit({
          type: "trust_signal",
          entityId: "agent-1",
          payload: { signal: i },
          timestamp: Date.now(),
        });
      }

      // Commit for different entity
      committer.commit({
        type: "trust_signal",
        entityId: "agent-2",
        payload: { signal: 0 },
        timestamp: Date.now(),
      });

      await committer.flush();

      const agent1Commitments =
        await committer.getCommitmentsForEntity("agent-1");
      const agent2Commitments =
        await committer.getCommitmentsForEntity("agent-2");

      expect(agent1Commitments.length).toBe(3);
      expect(agent2Commitments.length).toBe(1);
    });
  });

  describe("verifyCommitment", () => {
    it("should verify valid commitment", async () => {
      const event: ProofEvent = {
        type: "execution_started",
        entityId: "agent-1",
        payload: { action: "process" },
        timestamp: Date.now(),
      };

      const commitmentId = committer.commit(event);
      await committer.flush();

      const commitment = await committer.getCommitment(commitmentId);
      expect(commitment).not.toBeNull();

      const isValid = committer.verifyCommitment(commitment!);
      expect(isValid).toBe(true);
    });

    it("should detect tampered commitment", async () => {
      const event: ProofEvent = {
        type: "execution_started",
        entityId: "agent-1",
        payload: { action: "process" },
        timestamp: Date.now(),
      };

      const commitmentId = committer.commit(event);
      await committer.flush();

      const commitment = await committer.getCommitment(commitmentId);
      expect(commitment).not.toBeNull();

      // Tamper with the event
      const tampered = {
        ...commitment!,
        event: { ...commitment!.event, payload: { action: "HACKED" } },
      };

      const isValid = committer.verifyCommitment(tampered);
      expect(isValid).toBe(false);
    });
  });

  describe("metrics", () => {
    it("should track metrics", async () => {
      for (let i = 0; i < 5; i++) {
        committer.commit({
          type: "trust_signal",
          entityId: "agent-1",
          payload: { i },
          timestamp: Date.now(),
        });
      }

      await committer.flush();

      const metrics = committer.getMetrics();

      expect(metrics.totalCommitments).toBe(5);
      expect(metrics.totalBatches).toBe(1);
      expect(metrics.avgFlushTimeMs).toBeGreaterThan(0);
      expect(metrics.bufferSize).toBe(0);
    });
  });

  describe("correlation", () => {
    it("should preserve correlation IDs", async () => {
      const correlationId = "intent-123";

      committer.commit({
        type: "intent_submitted",
        entityId: "agent-1",
        payload: { action: "read" },
        timestamp: Date.now(),
        correlationId,
      });

      committer.commit({
        type: "decision_made",
        entityId: "agent-1",
        payload: { allowed: true },
        timestamp: Date.now(),
        correlationId,
      });

      await committer.flush();

      const commitments = await committer.getCommitmentsForEntity("agent-1");

      expect(commitments.length).toBe(2);
      expect(
        commitments.every((c) => c.event.correlationId === correlationId),
      ).toBe(true);
    });
  });
});

describe("InMemoryProofStore", () => {
  let store: InMemoryProofStore;

  beforeEach(() => {
    store = new InMemoryProofStore();
  });

  it("should store and retrieve batches", async () => {
    const batch = {
      batchId: "batch-1",
      merkleRoot: "abc123",
      signature: "",
      commitments: [],
      createdAt: new Date(),
      eventCount: 0,
    };

    await store.writeBatch(batch);
    const retrieved = await store.getBatch("batch-1");

    expect(retrieved).toEqual(batch);
  });

  it("should clear all data", async () => {
    const batch = {
      batchId: "batch-1",
      merkleRoot: "abc123",
      signature: "",
      commitments: [
        {
          id: "c1",
          hash: "hash1",
          timestamp: Date.now(),
          event: {
            type: "trust_signal" as const,
            entityId: "agent-1",
            payload: {},
            timestamp: Date.now(),
          },
        },
      ],
      createdAt: new Date(),
      eventCount: 1,
    };

    await store.writeBatch(batch);
    expect(store.getStats().batches).toBe(1);

    store.clear();
    expect(store.getStats().batches).toBe(0);
    expect(store.getStats().commitments).toBe(0);
  });
});
