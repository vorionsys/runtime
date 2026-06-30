// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Vorion LLC

/**
 * Trace Context - W3C Trace Context propagation for Vorion
 *
 * Provides trace ID generation and W3C `traceparent` header
 * parsing/serialization for distributed trace propagation.
 *
 * Uses node:crypto for ID generation (no external dependencies).
 *
 * @see https://www.w3.org/TR/trace-context/
 * @packageDocumentation
 */

import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** W3C Trace Context version byte (always 00 for current spec) */
const TRACE_CONTEXT_VERSION = '00';

/** Regex for a valid W3C `traceparent` header */
const TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

// ---------------------------------------------------------------------------
// ID generators
// ---------------------------------------------------------------------------

/**
 * Generate a 32-hex-char trace ID (128-bit).
 *
 * Uses `crypto.randomUUID()` with dashes stripped for W3C compatibility.
 */
export function generateTraceId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * Generate a 16-hex-char span ID (64-bit).
 */
export function generateSpanId(): string {
  return crypto.randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------------------
// Trace context
// ---------------------------------------------------------------------------

/**
 * Immutable trace context that propagates across service boundaries.
 */
export interface TraceContextFields {
  /** 32-hex-char trace ID shared by all spans in a trace */
  traceId: string;
  /** 16-hex-char span ID of the *parent* span (the caller) */
  parentSpanId: string;
  /** W3C trace flags byte (hex string, e.g. "01" = sampled) */
  traceFlags: string;
}

/**
 * TraceContext carries identifiers required to correlate spans
 * across process boundaries.
 *
 * Construct from scratch, from an incoming `traceparent` header,
 * or by creating a child context for a new span.
 */
export class TraceContext {
  readonly traceId: string;
  readonly parentSpanId: string;
  readonly traceFlags: string;

  constructor(fields?: Partial<TraceContextFields>) {
    this.traceId = fields?.traceId ?? generateTraceId();
    this.parentSpanId = fields?.parentSpanId ?? generateSpanId();
    this.traceFlags = fields?.traceFlags ?? '01'; // sampled by default
  }

  // -----------------------------------------------------------------------
  // Factory helpers
  // -----------------------------------------------------------------------

  /**
   * Parse a W3C `traceparent` header into a TraceContext.
   *
   * Format: `{version}-{traceId}-{parentId}-{traceFlags}`
   *
   * Returns `null` if the header is malformed.
   */
  static fromTraceparent(header: string): TraceContext | null {
    const match = TRACEPARENT_RE.exec(header.trim().toLowerCase());
    if (!match) {
      return null;
    }

    const [, _version, traceId, parentSpanId, traceFlags] = match;
    return new TraceContext({ traceId, parentSpanId, traceFlags });
  }

  /**
   * Create a child TraceContext for a new span.
   *
   * The child shares the same traceId but receives a fresh parentSpanId
   * (which should be the *current* span's spanId, supplied by the caller).
   */
  child(currentSpanId: string): TraceContext {
    return new TraceContext({
      traceId: this.traceId,
      parentSpanId: currentSpanId,
      traceFlags: this.traceFlags,
    });
  }

  // -----------------------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------------------

  /**
   * Serialize to a W3C `traceparent` header value.
   */
  toTraceparent(): string {
    return `${TRACE_CONTEXT_VERSION}-${this.traceId}-${this.parentSpanId}-${this.traceFlags}`;
  }

  /**
   * Return a plain object suitable for JSON serialization / logging.
   */
  toJSON(): TraceContextFields {
    return {
      traceId: this.traceId,
      parentSpanId: this.parentSpanId,
      traceFlags: this.traceFlags,
    };
  }

  // -----------------------------------------------------------------------
  // Convenience
  // -----------------------------------------------------------------------

  /** Whether the "sampled" flag (bit 0) is set */
  get isSampled(): boolean {
    return (parseInt(this.traceFlags, 16) & 0x01) === 1;
  }
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

/**
 * Extract a TraceContext from an incoming HTTP headers object.
 *
 * Accepts both `traceparent` (W3C standard) and `x-trace-id` (Vorion
 * convenience header). If neither is present, returns a fresh context.
 */
export function extractTraceContext(
  headers: Record<string, string | string[] | undefined>
): TraceContext {
  // Normalize header keys to lowercase
  const get = (key: string): string | undefined => {
    const raw = headers[key] ?? headers[key.toLowerCase()];
    return Array.isArray(raw) ? raw[0] : raw;
  };

  const traceparent = get('traceparent');
  if (traceparent) {
    const ctx = TraceContext.fromTraceparent(traceparent);
    if (ctx) return ctx;
  }

  // Fallback: Vorion-specific convenience header
  const xTraceId = get('x-trace-id');
  if (xTraceId) {
    return new TraceContext({ traceId: xTraceId });
  }

  // No propagation — start a new trace
  return new TraceContext();
}

/**
 * Inject trace context into outgoing HTTP headers.
 */
export function injectTraceContext(
  ctx: TraceContext,
  headers: Record<string, string>
): Record<string, string> {
  headers['traceparent'] = ctx.toTraceparent();
  return headers;
}
