// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Vorion LLC

/**
 * Vorion Tracing Abstraction
 *
 * Lightweight, zero-dependency tracing layer that follows the OpenTelemetry
 * Span/Tracer model. Ships with three built-in implementations:
 *
 * - **NoopTracer** - Zero overhead; the default. Use in production when no
 *   OTel SDK is wired.
 * - **ConsoleTracer** - Logs spans as structured JSON to `console.log`.
 *   Useful during local development.
 * - **InMemoryTracer** - Accumulates spans in an array. Ideal for tests
 *   and snapshot assertions.
 *
 * To wire a real OTel SDK later, implement the {@link Tracer} interface
 * and call {@link setTracer}.
 *
 * @example
 * ```ts
 * import { setTracer, ConsoleTracer, withSpan } from '@vorionsys/runtime/tracing';
 *
 * setTracer(new ConsoleTracer());
 *
 * const result = await withSpan('vorion.intent.submit', async (span) => {
 *   span.attributes['agent.id'] = 'agent-42';
 *   return submitIntent();
 * });
 * ```
 *
 * @packageDocumentation
 */

import { generateTraceId, generateSpanId } from './context.js';

// Re-export everything from context for single-import convenience
export {
  TraceContext,
  generateTraceId,
  generateSpanId,
  extractTraceContext,
  injectTraceContext,
  type TraceContextFields,
} from './context.js';

// ---------------------------------------------------------------------------
// Span
// ---------------------------------------------------------------------------

/** Status of a completed span */
export type SpanStatus = 'ok' | 'error' | 'unset';

/**
 * Represents a single unit of work within a trace.
 *
 * Follows the OpenTelemetry Span data model so that migrating to a
 * real OTel SDK requires no structural changes.
 */
export interface Span {
  /** 32-hex-char trace ID shared by all spans in the trace */
  traceId: string;
  /** 16-hex-char unique identifier for this span */
  spanId: string;
  /** Parent span ID (undefined for root spans) */
  parentSpanId?: string;
  /** Human-readable span name (e.g. "vorion.intent.submit") */
  name: string;
  /** High-resolution start time (ms since epoch, via `performance.now()` offset) */
  startTime: number;
  /** High-resolution end time; undefined while the span is still open */
  endTime?: number;
  /** Span completion status */
  status: SpanStatus;
  /** Arbitrary key-value attributes attached to this span */
  attributes: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tracer interface
// ---------------------------------------------------------------------------

/**
 * Minimal tracer interface modeled after OpenTelemetry's `Tracer`.
 *
 * Implement this interface to bridge Vorion tracing to any backend
 * (OTel SDK, Datadog, custom collector, etc.).
 */
export interface Tracer {
  /**
   * Create and start a new span.
   *
   * @param name - Span name following Vorion conventions
   *               (e.g. `vorion.intent.submit`, `vorion.trust.check`)
   * @param attributes - Optional initial attributes
   * @param parentSpanId - Optional parent span ID for nesting
   * @returns A mutable Span; call `endSpan()` when done
   */
  startSpan(
    name: string,
    attributes?: Record<string, unknown>,
    parentSpanId?: string
  ): Span;

  /**
   * Mark a span as ended and submit it for export/storage.
   *
   * @param span - The span to end (mutates `endTime` and `status`)
   */
  endSpan(span: Span): void;
}

// ---------------------------------------------------------------------------
// NoopTracer
// ---------------------------------------------------------------------------

/** Reusable frozen noop span — avoids allocation on every call. */
const NOOP_SPAN: Span = Object.freeze({
  traceId: '0'.repeat(32),
  spanId: '0'.repeat(16),
  parentSpanId: undefined,
  name: 'noop',
  startTime: 0,
  endTime: 0,
  status: 'unset' as SpanStatus,
  attributes: Object.freeze({}) as Record<string, unknown>,
});

/**
 * A tracer that does absolutely nothing.
 *
 * This is the default tracer returned by {@link getTracer} when no
 * tracer has been configured. It guarantees **zero** overhead: no
 * allocations, no I/O, no side effects.
 */
export class NoopTracer implements Tracer {
  startSpan(): Span {
    return NOOP_SPAN;
  }

  endSpan(): void {
    // intentionally empty
  }
}

// ---------------------------------------------------------------------------
// ConsoleTracer
// ---------------------------------------------------------------------------

/**
 * Options for {@link ConsoleTracer}.
 */
export interface ConsoleTracerOptions {
  /** Include attributes in the log output (default: true) */
  includeAttributes?: boolean;
  /** Pretty-print JSON (default: false — single-line for log aggregation) */
  prettyPrint?: boolean;
}

/**
 * Logs completed spans to `console.log` as structured JSON.
 *
 * Useful during local development to see the full span lifecycle
 * without standing up a collector.
 */
export class ConsoleTracer implements Tracer {
  private readonly traceId: string;
  private readonly includeAttributes: boolean;
  private readonly prettyPrint: boolean;

  constructor(options?: ConsoleTracerOptions) {
    this.traceId = generateTraceId();
    this.includeAttributes = options?.includeAttributes ?? true;
    this.prettyPrint = options?.prettyPrint ?? false;
  }

  startSpan(
    name: string,
    attributes?: Record<string, unknown>,
    parentSpanId?: string
  ): Span {
    return {
      traceId: this.traceId,
      spanId: generateSpanId(),
      parentSpanId,
      name,
      startTime: Date.now(),
      endTime: undefined,
      status: 'unset',
      attributes: { ...attributes },
    };
  }

  endSpan(span: Span): void {
    span.endTime = Date.now();
    if (span.status === 'unset') {
      span.status = 'ok';
    }

    const durationMs = span.endTime - span.startTime;

    const entry: Record<string, unknown> = {
      level: 'trace',
      service: 'vorion',
      traceId: span.traceId,
      spanId: span.spanId,
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
      name: span.name,
      status: span.status,
      durationMs,
      ...(this.includeAttributes && Object.keys(span.attributes).length > 0
        ? { attributes: span.attributes }
        : {}),
    };

    const indent = this.prettyPrint ? 2 : undefined;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(entry, null, indent));
  }
}

// ---------------------------------------------------------------------------
// InMemoryTracer
// ---------------------------------------------------------------------------

/**
 * Accumulates completed spans in memory for inspection.
 *
 * Designed for use in tests and development tooling where you need to
 * assert on the spans that were produced.
 */
export class InMemoryTracer implements Tracer {
  /** All completed spans, in order of completion */
  readonly spans: Span[] = [];

  private readonly traceId: string;

  constructor() {
    this.traceId = generateTraceId();
  }

  startSpan(
    name: string,
    attributes?: Record<string, unknown>,
    parentSpanId?: string
  ): Span {
    return {
      traceId: this.traceId,
      spanId: generateSpanId(),
      parentSpanId,
      name,
      startTime: Date.now(),
      endTime: undefined,
      status: 'unset',
      attributes: { ...attributes },
    };
  }

  endSpan(span: Span): void {
    span.endTime = Date.now();
    if (span.status === 'unset') {
      span.status = 'ok';
    }
    this.spans.push(span);
  }

  // -----------------------------------------------------------------------
  // Test helpers
  // -----------------------------------------------------------------------

  /** Find all spans matching a name prefix (e.g. "vorion.intent") */
  findByPrefix(prefix: string): Span[] {
    return this.spans.filter((s) => s.name.startsWith(prefix));
  }

  /** Find a single span by exact name. Throws if not found. */
  findByName(name: string): Span {
    const span = this.spans.find((s) => s.name === name);
    if (!span) {
      throw new Error(`Span not found: ${name}`);
    }
    return span;
  }

  /** Number of collected spans */
  get count(): number {
    return this.spans.length;
  }

  /** Clear all collected spans */
  clear(): void {
    this.spans.length = 0;
  }

  /** Get stats for assertions */
  getStats(): { count: number; errorCount: number; avgDurationMs: number } {
    const errorCount = this.spans.filter((s) => s.status === 'error').length;
    const totalDuration = this.spans.reduce(
      (sum, s) => sum + ((s.endTime ?? s.startTime) - s.startTime),
      0
    );
    return {
      count: this.spans.length,
      errorCount,
      avgDurationMs: this.spans.length > 0 ? totalDuration / this.spans.length : 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Global tracer accessor
// ---------------------------------------------------------------------------

/** The singleton tracer instance. Defaults to NoopTracer. */
let _globalTracer: Tracer = new NoopTracer();

/**
 * Get the currently configured global tracer.
 *
 * Returns a {@link NoopTracer} unless {@link setTracer} has been called.
 */
export function getTracer(): Tracer {
  return _globalTracer;
}

/**
 * Set the global tracer.
 *
 * Call this once during application bootstrap to enable tracing:
 *
 * ```ts
 * import { setTracer, ConsoleTracer } from '@vorionsys/runtime/tracing';
 * setTracer(new ConsoleTracer());
 * ```
 *
 * @param tracer - The tracer implementation to use globally
 */
export function setTracer(tracer: Tracer): void {
  _globalTracer = tracer;
}

/**
 * Reset the global tracer back to the default NoopTracer.
 *
 * Primarily useful in test teardown to avoid state leaking between tests.
 */
export function resetTracer(): void {
  _globalTracer = new NoopTracer();
}

// ---------------------------------------------------------------------------
// withSpan helper
// ---------------------------------------------------------------------------

/**
 * Execute an async function within a traced span.
 *
 * Automatically starts a span, passes it to the callback, and ends it
 * when the callback resolves or rejects. On rejection the span status
 * is set to `'error'` and the `error.message` attribute is populated.
 *
 * @param name - Span name (recommend Vorion conventions: `vorion.<domain>.<operation>`)
 * @param fn - Async function to execute. Receives the active span for attribute enrichment.
 * @param attributes - Optional initial span attributes
 * @param parentSpanId - Optional parent span ID for nesting
 * @returns The value returned by `fn`
 *
 * @example
 * ```ts
 * const result = await withSpan('vorion.trust.check', async (span) => {
 *   span.attributes['agent.id'] = agentId;
 *   const score = await trustFacade.getScore(agentId);
 *   span.attributes['trust.score'] = score;
 *   return score;
 * });
 * ```
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, unknown>,
  parentSpanId?: string
): Promise<T> {
  const tracer = getTracer();
  const span = tracer.startSpan(name, attributes, parentSpanId);

  try {
    const result = await fn(span);
    span.status = 'ok';
    return result;
  } catch (err) {
    span.status = 'error';
    span.attributes['error.message'] =
      err instanceof Error ? err.message : String(err);
    span.attributes['error.type'] =
      err instanceof Error ? err.constructor.name : 'unknown';
    throw err;
  } finally {
    tracer.endSpan(span);
  }
}

/**
 * Synchronous variant of {@link withSpan} for non-async operations.
 *
 * Same semantics, but wraps a synchronous function.
 */
export function withSpanSync<T>(
  name: string,
  fn: (span: Span) => T,
  attributes?: Record<string, unknown>,
  parentSpanId?: string
): T {
  const tracer = getTracer();
  const span = tracer.startSpan(name, attributes, parentSpanId);

  try {
    const result = fn(span);
    span.status = 'ok';
    return result;
  } catch (err) {
    span.status = 'error';
    span.attributes['error.message'] =
      err instanceof Error ? err.message : String(err);
    span.attributes['error.type'] =
      err instanceof Error ? err.constructor.name : 'unknown';
    throw err;
  } finally {
    tracer.endSpan(span);
  }
}
