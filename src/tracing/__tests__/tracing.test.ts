// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Vorion LLC

/**
 * Tracing System Tests
 *
 * Covers: Span, NoopTracer, ConsoleTracer, InMemoryTracer,
 * withSpan(), withSpanSync(), TraceContext W3C traceparent,
 * global tracer accessor, extractTraceContext, injectTraceContext
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  NoopTracer,
  ConsoleTracer,
  InMemoryTracer,
  getTracer,
  setTracer,
  resetTracer,
  withSpan,
  withSpanSync,
  TraceContext,
  generateTraceId,
  generateSpanId,
  extractTraceContext,
  injectTraceContext,
  type Span,
} from '../index.js';

// ---------------------------------------------------------------------------
// ID generators
// ---------------------------------------------------------------------------

describe('generateTraceId', () => {
  it('should produce a 32-hex-char string', () => {
    const id = generateTraceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('should produce unique values on each call', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateTraceId()));
    expect(ids.size).toBe(50);
  });
});

describe('generateSpanId', () => {
  it('should produce a 16-hex-char string', () => {
    const id = generateSpanId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('should produce unique values on each call', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateSpanId()));
    expect(ids.size).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// NoopTracer
// ---------------------------------------------------------------------------

describe('NoopTracer', () => {
  let tracer: NoopTracer;

  beforeEach(() => {
    tracer = new NoopTracer();
  });

  it('should return a frozen noop span from startSpan', () => {
    const span = tracer.startSpan();
    expect(span.traceId).toBe('0'.repeat(32));
    expect(span.spanId).toBe('0'.repeat(16));
    expect(span.name).toBe('noop');
    expect(span.startTime).toBe(0);
    expect(span.endTime).toBe(0);
    expect(span.status).toBe('unset');
  });

  it('should return the same frozen span every time', () => {
    const span1 = tracer.startSpan();
    const span2 = tracer.startSpan();
    expect(span1).toBe(span2);
  });

  it('should have frozen attributes', () => {
    const span = tracer.startSpan();
    expect(Object.isFrozen(span.attributes)).toBe(true);
  });

  it('should endSpan without throwing', () => {
    const span = tracer.startSpan();
    expect(() => tracer.endSpan(span)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ConsoleTracer
// ---------------------------------------------------------------------------

describe('ConsoleTracer', () => {
  let tracer: ConsoleTracer;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should create spans with valid trace and span IDs', () => {
    tracer = new ConsoleTracer();
    const span = tracer.startSpan('test.span');

    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.name).toBe('test.span');
    expect(span.status).toBe('unset');
    expect(span.endTime).toBeUndefined();
  });

  it('should use the same traceId for all spans from one tracer', () => {
    tracer = new ConsoleTracer();
    const span1 = tracer.startSpan('span.1');
    const span2 = tracer.startSpan('span.2');
    expect(span1.traceId).toBe(span2.traceId);
  });

  it('should assign unique spanId to each span', () => {
    tracer = new ConsoleTracer();
    const span1 = tracer.startSpan('span.1');
    const span2 = tracer.startSpan('span.2');
    expect(span1.spanId).not.toBe(span2.spanId);
  });

  it('should spread initial attributes into the span', () => {
    tracer = new ConsoleTracer();
    const span = tracer.startSpan('test', { 'agent.id': 'a1' });
    expect(span.attributes['agent.id']).toBe('a1');
  });

  it('should not share attribute references across spans', () => {
    tracer = new ConsoleTracer();
    const attrs = { key: 'val' };
    const span = tracer.startSpan('test', attrs);
    attrs.key = 'mutated';
    expect(span.attributes['key']).toBe('val');
  });

  it('should set parentSpanId when provided', () => {
    tracer = new ConsoleTracer();
    const span = tracer.startSpan('child', {}, 'parent123');
    expect(span.parentSpanId).toBe('parent123');
  });

  it('should set endTime and status on endSpan', () => {
    tracer = new ConsoleTracer();
    const span = tracer.startSpan('test');
    tracer.endSpan(span);

    expect(span.endTime).toBeDefined();
    expect(span.endTime).toBeGreaterThanOrEqual(span.startTime);
    expect(span.status).toBe('ok');
  });

  it('should preserve error status if already set before endSpan', () => {
    tracer = new ConsoleTracer();
    const span = tracer.startSpan('test');
    span.status = 'error';
    tracer.endSpan(span);
    expect(span.status).toBe('error');
  });

  it('should log structured JSON on endSpan', () => {
    tracer = new ConsoleTracer();
    const span = tracer.startSpan('test.op', { key: 'value' });
    tracer.endSpan(span);

    expect(consoleSpy).toHaveBeenCalledOnce();
    const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(logged.level).toBe('trace');
    expect(logged.service).toBe('vorion');
    expect(logged.name).toBe('test.op');
    expect(logged.traceId).toBe(span.traceId);
    expect(logged.spanId).toBe(span.spanId);
    expect(logged.status).toBe('ok');
    expect(logged.durationMs).toBeGreaterThanOrEqual(0);
    expect(logged.attributes).toEqual({ key: 'value' });
  });

  it('should omit parentSpanId from log when undefined', () => {
    tracer = new ConsoleTracer();
    const span = tracer.startSpan('root.span');
    tracer.endSpan(span);

    const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(logged.parentSpanId).toBeUndefined();
  });

  it('should include parentSpanId in log when present', () => {
    tracer = new ConsoleTracer();
    const span = tracer.startSpan('child.span', {}, 'parent-abc');
    tracer.endSpan(span);

    const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(logged.parentSpanId).toBe('parent-abc');
  });

  it('should omit attributes from log when includeAttributes is false', () => {
    tracer = new ConsoleTracer({ includeAttributes: false });
    const span = tracer.startSpan('test', { key: 'value' });
    tracer.endSpan(span);

    const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(logged.attributes).toBeUndefined();
  });

  it('should omit attributes from log when attributes object is empty', () => {
    tracer = new ConsoleTracer({ includeAttributes: true });
    const span = tracer.startSpan('test');
    tracer.endSpan(span);

    const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(logged.attributes).toBeUndefined();
  });

  it('should pretty-print when prettyPrint is true', () => {
    tracer = new ConsoleTracer({ prettyPrint: true });
    const span = tracer.startSpan('test');
    tracer.endSpan(span);

    const output = consoleSpy.mock.calls[0][0] as string;
    // Pretty-printed JSON has newlines
    expect(output).toContain('\n');
  });

  it('should output single-line JSON by default', () => {
    tracer = new ConsoleTracer();
    const span = tracer.startSpan('test');
    tracer.endSpan(span);

    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).not.toContain('\n');
  });
});

// ---------------------------------------------------------------------------
// InMemoryTracer
// ---------------------------------------------------------------------------

describe('InMemoryTracer', () => {
  let tracer: InMemoryTracer;

  beforeEach(() => {
    tracer = new InMemoryTracer();
  });

  it('should accumulate completed spans', () => {
    const span1 = tracer.startSpan('op.1');
    const span2 = tracer.startSpan('op.2');
    tracer.endSpan(span1);
    tracer.endSpan(span2);

    expect(tracer.spans).toHaveLength(2);
    expect(tracer.count).toBe(2);
  });

  it('should share the same traceId across all spans', () => {
    const s1 = tracer.startSpan('a');
    const s2 = tracer.startSpan('b');
    expect(s1.traceId).toBe(s2.traceId);
    expect(s1.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('should set endTime and status on endSpan', () => {
    const span = tracer.startSpan('test');
    tracer.endSpan(span);

    expect(span.endTime).toBeDefined();
    expect(span.status).toBe('ok');
  });

  it('should preserve error status if already set', () => {
    const span = tracer.startSpan('test');
    span.status = 'error';
    tracer.endSpan(span);

    expect(span.status).toBe('error');
  });

  it('should apply initial attributes', () => {
    const span = tracer.startSpan('test', { 'agent.id': 'x' });
    expect(span.attributes['agent.id']).toBe('x');
  });

  it('should set parentSpanId when provided', () => {
    const span = tracer.startSpan('child', {}, 'p123');
    expect(span.parentSpanId).toBe('p123');
  });

  describe('findByPrefix', () => {
    it('should return spans matching a name prefix', () => {
      tracer.endSpan(tracer.startSpan('vorion.intent.submit'));
      tracer.endSpan(tracer.startSpan('vorion.intent.check'));
      tracer.endSpan(tracer.startSpan('vorion.trust.check'));

      const intents = tracer.findByPrefix('vorion.intent');
      expect(intents).toHaveLength(2);
      expect(intents.every((s) => s.name.startsWith('vorion.intent'))).toBe(true);
    });

    it('should return empty array when no spans match', () => {
      tracer.endSpan(tracer.startSpan('a'));
      expect(tracer.findByPrefix('nonexistent')).toHaveLength(0);
    });
  });

  describe('findByName', () => {
    it('should return the span with exact name match', () => {
      tracer.endSpan(tracer.startSpan('unique.name'));
      const found = tracer.findByName('unique.name');
      expect(found.name).toBe('unique.name');
    });

    it('should throw when span not found', () => {
      expect(() => tracer.findByName('missing')).toThrow('Span not found: missing');
    });
  });

  describe('clear', () => {
    it('should remove all spans', () => {
      tracer.endSpan(tracer.startSpan('a'));
      tracer.endSpan(tracer.startSpan('b'));
      tracer.clear();
      expect(tracer.count).toBe(0);
      expect(tracer.spans).toHaveLength(0);
    });
  });

  describe('getStats', () => {
    it('should calculate correct stats', () => {
      const s1 = tracer.startSpan('ok.span');
      tracer.endSpan(s1);

      const s2 = tracer.startSpan('err.span');
      s2.status = 'error';
      tracer.endSpan(s2);

      const stats = tracer.getStats();
      expect(stats.count).toBe(2);
      expect(stats.errorCount).toBe(1);
      expect(stats.avgDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('should return zero avgDurationMs when no spans collected', () => {
      const stats = tracer.getStats();
      expect(stats.count).toBe(0);
      expect(stats.errorCount).toBe(0);
      expect(stats.avgDurationMs).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Global tracer accessor
// ---------------------------------------------------------------------------

describe('Global tracer accessor', () => {
  afterEach(() => {
    resetTracer();
  });

  it('should default to NoopTracer', () => {
    resetTracer();
    const tracer = getTracer();
    expect(tracer).toBeInstanceOf(NoopTracer);
  });

  it('should return the tracer set by setTracer', () => {
    const custom = new InMemoryTracer();
    setTracer(custom);
    expect(getTracer()).toBe(custom);
  });

  it('should reset back to NoopTracer', () => {
    setTracer(new InMemoryTracer());
    resetTracer();
    expect(getTracer()).toBeInstanceOf(NoopTracer);
  });
});

// ---------------------------------------------------------------------------
// withSpan (async)
// ---------------------------------------------------------------------------

describe('withSpan', () => {
  let tracer: InMemoryTracer;

  beforeEach(() => {
    tracer = new InMemoryTracer();
    setTracer(tracer);
  });

  afterEach(() => {
    resetTracer();
  });

  it('should execute the callback and return its value', async () => {
    const result = await withSpan('test.op', async () => 42);
    expect(result).toBe(42);
  });

  it('should create and end a span', async () => {
    await withSpan('my.operation', async (span) => {
      span.attributes['key'] = 'val';
    });

    expect(tracer.count).toBe(1);
    const span = tracer.findByName('my.operation');
    expect(span.status).toBe('ok');
    expect(span.endTime).toBeDefined();
    expect(span.attributes['key']).toBe('val');
  });

  it('should pass initial attributes', async () => {
    await withSpan('test', async () => {}, { initial: true });

    const span = tracer.findByName('test');
    expect(span.attributes['initial']).toBe(true);
  });

  it('should pass parentSpanId', async () => {
    await withSpan('child', async () => {}, {}, 'parent-id');

    const span = tracer.findByName('child');
    expect(span.parentSpanId).toBe('parent-id');
  });

  it('should set error status and attributes on rejection', async () => {
    await expect(
      withSpan('failing', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const span = tracer.findByName('failing');
    expect(span.status).toBe('error');
    expect(span.attributes['error.message']).toBe('boom');
    expect(span.attributes['error.type']).toBe('Error');
    expect(span.endTime).toBeDefined();
  });

  it('should handle non-Error throws', async () => {
    await expect(
      withSpan('str-throw', async () => {
        throw 'string-error'; // eslint-disable-line no-throw-literal
      })
    ).rejects.toBe('string-error');

    const span = tracer.findByName('str-throw');
    expect(span.status).toBe('error');
    expect(span.attributes['error.message']).toBe('string-error');
    expect(span.attributes['error.type']).toBe('unknown');
  });

  it('should end the span even when the callback throws', async () => {
    try {
      await withSpan('will-fail', async () => {
        throw new Error('fail');
      });
    } catch {
      // expected
    }

    expect(tracer.count).toBe(1);
    expect(tracer.findByName('will-fail').endTime).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// withSpanSync
// ---------------------------------------------------------------------------

describe('withSpanSync', () => {
  let tracer: InMemoryTracer;

  beforeEach(() => {
    tracer = new InMemoryTracer();
    setTracer(tracer);
  });

  afterEach(() => {
    resetTracer();
  });

  it('should execute synchronously and return the value', () => {
    const result = withSpanSync('sync.op', () => 'hello');
    expect(result).toBe('hello');
  });

  it('should create and end a span with ok status', () => {
    withSpanSync('sync.test', (span) => {
      span.attributes['sync'] = true;
    });

    expect(tracer.count).toBe(1);
    const span = tracer.findByName('sync.test');
    expect(span.status).toBe('ok');
    expect(span.endTime).toBeDefined();
    expect(span.attributes['sync']).toBe(true);
  });

  it('should pass initial attributes and parentSpanId', () => {
    withSpanSync('child.sync', () => {}, { init: 'yes' }, 'parent-sync');

    const span = tracer.findByName('child.sync');
    expect(span.attributes['init']).toBe('yes');
    expect(span.parentSpanId).toBe('parent-sync');
  });

  it('should set error status on throw and re-throw', () => {
    expect(() =>
      withSpanSync('sync.fail', () => {
        throw new Error('sync-boom');
      })
    ).toThrow('sync-boom');

    const span = tracer.findByName('sync.fail');
    expect(span.status).toBe('error');
    expect(span.attributes['error.message']).toBe('sync-boom');
    expect(span.attributes['error.type']).toBe('Error');
    expect(span.endTime).toBeDefined();
  });

  it('should handle non-Error throws', () => {
    expect(() =>
      withSpanSync('sync.str', () => {
        throw 42; // eslint-disable-line no-throw-literal
      })
    ).toThrow();

    const span = tracer.findByName('sync.str');
    expect(span.attributes['error.message']).toBe('42');
    expect(span.attributes['error.type']).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// TraceContext
// ---------------------------------------------------------------------------

describe('TraceContext', () => {
  describe('constructor', () => {
    it('should generate traceId and parentSpanId when no fields provided', () => {
      const ctx = new TraceContext();
      expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(ctx.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
      expect(ctx.traceFlags).toBe('01');
    });

    it('should accept partial fields', () => {
      const ctx = new TraceContext({ traceId: 'a'.repeat(32) });
      expect(ctx.traceId).toBe('a'.repeat(32));
      expect(ctx.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
      expect(ctx.traceFlags).toBe('01');
    });

    it('should accept all fields', () => {
      const ctx = new TraceContext({
        traceId: 'b'.repeat(32),
        parentSpanId: 'c'.repeat(16),
        traceFlags: '00',
      });
      expect(ctx.traceId).toBe('b'.repeat(32));
      expect(ctx.parentSpanId).toBe('c'.repeat(16));
      expect(ctx.traceFlags).toBe('00');
    });
  });

  describe('fromTraceparent', () => {
    it('should parse a valid W3C traceparent header', () => {
      const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
      const ctx = TraceContext.fromTraceparent(header);

      expect(ctx).not.toBeNull();
      expect(ctx!.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
      expect(ctx!.parentSpanId).toBe('00f067aa0ba902b7');
      expect(ctx!.traceFlags).toBe('01');
    });

    it('should handle leading/trailing whitespace', () => {
      const header = '  00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01  ';
      const ctx = TraceContext.fromTraceparent(header);
      expect(ctx).not.toBeNull();
      expect(ctx!.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    });

    it('should handle uppercase hex (case-insensitive)', () => {
      const header = '00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01';
      const ctx = TraceContext.fromTraceparent(header);
      expect(ctx).not.toBeNull();
      expect(ctx!.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    });

    it('should return null for malformed headers', () => {
      expect(TraceContext.fromTraceparent('')).toBeNull();
      expect(TraceContext.fromTraceparent('garbage')).toBeNull();
      expect(TraceContext.fromTraceparent('00-short-id-01')).toBeNull();
      expect(TraceContext.fromTraceparent('00-ZZZZ0000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull();
    });

    it('should return null for invalid version format', () => {
      // version must be 2 hex chars
      expect(TraceContext.fromTraceparent('0-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull();
    });

    it('should parse unsampled trace flags', () => {
      const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00';
      const ctx = TraceContext.fromTraceparent(header);
      expect(ctx).not.toBeNull();
      expect(ctx!.traceFlags).toBe('00');
      expect(ctx!.isSampled).toBe(false);
    });
  });

  describe('child', () => {
    it('should create a child with the same traceId', () => {
      const parent = new TraceContext({
        traceId: 'd'.repeat(32),
        parentSpanId: 'e'.repeat(16),
        traceFlags: '01',
      });

      const child = parent.child('f'.repeat(16));

      expect(child.traceId).toBe('d'.repeat(32));
      expect(child.parentSpanId).toBe('f'.repeat(16));
      expect(child.traceFlags).toBe('01');
    });

    it('should preserve traceFlags from parent', () => {
      const parent = new TraceContext({ traceFlags: '00' });
      const child = parent.child(generateSpanId());
      expect(child.traceFlags).toBe('00');
    });
  });

  describe('toTraceparent', () => {
    it('should serialize to W3C traceparent format', () => {
      const ctx = new TraceContext({
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        parentSpanId: '00f067aa0ba902b7',
        traceFlags: '01',
      });

      expect(ctx.toTraceparent()).toBe(
        '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
      );
    });

    it('should roundtrip through fromTraceparent', () => {
      const original = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
      const ctx = TraceContext.fromTraceparent(original)!;
      expect(ctx.toTraceparent()).toBe(original);
    });
  });

  describe('toJSON', () => {
    it('should return a plain object with all fields', () => {
      const ctx = new TraceContext({
        traceId: 'a'.repeat(32),
        parentSpanId: 'b'.repeat(16),
        traceFlags: '01',
      });

      const json = ctx.toJSON();
      expect(json).toEqual({
        traceId: 'a'.repeat(32),
        parentSpanId: 'b'.repeat(16),
        traceFlags: '01',
      });
    });
  });

  describe('isSampled', () => {
    it('should return true when trace flags bit 0 is set', () => {
      const ctx = new TraceContext({ traceFlags: '01' });
      expect(ctx.isSampled).toBe(true);
    });

    it('should return false when trace flags bit 0 is not set', () => {
      const ctx = new TraceContext({ traceFlags: '00' });
      expect(ctx.isSampled).toBe(false);
    });

    it('should check only bit 0 (sampled bit)', () => {
      // '03' has bits 0 and 1 set — sampled bit is still set
      const ctx = new TraceContext({ traceFlags: '03' });
      expect(ctx.isSampled).toBe(true);

      // '02' has only bit 1 set — sampled bit is NOT set
      const ctx2 = new TraceContext({ traceFlags: '02' });
      expect(ctx2.isSampled).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// extractTraceContext
// ---------------------------------------------------------------------------

describe('extractTraceContext', () => {
  it('should extract from a valid traceparent header', () => {
    const ctx = extractTraceContext({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });

    expect(ctx.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(ctx.parentSpanId).toBe('00f067aa0ba902b7');
  });

  it('should fall back to x-trace-id header', () => {
    const traceId = 'a'.repeat(32);
    const ctx = extractTraceContext({ 'x-trace-id': traceId });

    expect(ctx.traceId).toBe(traceId);
  });

  it('should prefer traceparent over x-trace-id', () => {
    const ctx = extractTraceContext({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      'x-trace-id': 'b'.repeat(32),
    });

    expect(ctx.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('should create a new context when no headers present', () => {
    const ctx = extractTraceContext({});
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('should create a new context when traceparent is malformed', () => {
    const ctx = extractTraceContext({ traceparent: 'bad-header' });
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('should handle array header values (take first)', () => {
    const ctx = extractTraceContext({
      traceparent: [
        '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        '00-0000000000000000000000000000dead-00f067aa0ba902b7-01',
      ],
    });

    expect(ctx.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('should handle undefined header values', () => {
    const ctx = extractTraceContext({ traceparent: undefined });
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// injectTraceContext
// ---------------------------------------------------------------------------

describe('injectTraceContext', () => {
  it('should inject traceparent into headers', () => {
    const ctx = new TraceContext({
      traceId: 'a'.repeat(32),
      parentSpanId: 'b'.repeat(16),
      traceFlags: '01',
    });

    const headers: Record<string, string> = {};
    const result = injectTraceContext(ctx, headers);

    expect(result.traceparent).toBe(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
    expect(result).toBe(headers); // mutates in-place
  });

  it('should overwrite existing traceparent', () => {
    const ctx = new TraceContext({
      traceId: 'c'.repeat(32),
      parentSpanId: 'd'.repeat(16),
      traceFlags: '01',
    });

    const headers: Record<string, string> = { traceparent: 'old' };
    injectTraceContext(ctx, headers);

    expect(headers.traceparent).toContain('c'.repeat(32));
  });
});
