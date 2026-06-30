# @vorionsys/runtime — Tracing

Lightweight, zero-dependency tracing abstraction for Vorion. Follows the
OpenTelemetry Span/Tracer model so that wiring a real OTel SDK later requires
only implementing a single interface.

## Quick start

### Development — ConsoleTracer

Logs every completed span as a single-line JSON object to `console.log`.

```ts
import { setTracer, ConsoleTracer } from '@vorionsys/runtime/tracing';

// Call once during bootstrap
setTracer(new ConsoleTracer());
```

Sample output:

```json
{"level":"trace","service":"vorion","traceId":"a1b2c3...","spanId":"d4e5f6...","name":"vorion.intent.submit","status":"ok","durationMs":12,"attributes":{"agent.id":"agent-42"}}
```

### Testing — InMemoryTracer

Collects spans in an array for assertions.

```ts
import { setTracer, resetTracer, InMemoryTracer, withSpan } from '@vorionsys/runtime/tracing';

const tracer = new InMemoryTracer();
setTracer(tracer);

await withSpan('vorion.trust.check', async (span) => {
  span.attributes['agent.id'] = 'agent-42';
  // ...your logic...
});

expect(tracer.count).toBe(1);
expect(tracer.findByName('vorion.trust.check').status).toBe('ok');

// Clean up after test
resetTracer();
tracer.clear();
```

### Production — NoopTracer (default)

The default tracer does nothing and allocates nothing. If you never call
`setTracer()`, tracing has zero runtime overhead.

## Connecting to OpenTelemetry

Implement the `Tracer` interface and delegate to the OTel SDK:

```ts
import { type Tracer, type Span, setTracer } from '@vorionsys/runtime/tracing';
import { trace } from '@opentelemetry/api';

class OTelTracer implements Tracer {
  private otel = trace.getTracer('vorion');

  startSpan(name: string, attributes?: Record<string, unknown>): Span {
    const otelSpan = this.otel.startSpan(name, { attributes });
    const ctx = otelSpan.spanContext();
    return {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      name,
      startTime: Date.now(),
      status: 'unset',
      attributes: { ...attributes },
      // Stash the OTel span for endSpan()
      _otelSpan: otelSpan,
    } as Span & { _otelSpan: typeof otelSpan };
  }

  endSpan(span: Span): void {
    const s = span as Span & { _otelSpan?: ReturnType<typeof this.otel.startSpan> };
    if (s._otelSpan) {
      if (span.status === 'error') {
        s._otelSpan.setStatus({ code: 2, message: String(span.attributes['error.message'] ?? '') });
      }
      s._otelSpan.end();
    }
  }
}

setTracer(new OTelTracer());
```

## Trace context propagation

Use `extractTraceContext` and `injectTraceContext` for W3C Trace Context
header propagation across service boundaries:

```ts
import { extractTraceContext, injectTraceContext } from '@vorionsys/runtime/tracing';

// Incoming request — extract context from headers
const ctx = extractTraceContext(request.headers);

// Outgoing request — inject context into headers
const headers: Record<string, string> = {};
injectTraceContext(ctx, headers);
fetch(url, { headers });
```

The `traceparent` header format follows the W3C spec:

```
{version}-{traceId}-{parentId}-{traceFlags}
00-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6-e7f8a9b0c1d2e3f4-01
```

## Span naming conventions

All Vorion spans follow a dot-delimited namespace:

| Prefix               | Domain                 | Examples                                         |
| -------------------- | ---------------------- | ------------------------------------------------ |
| `vorion.intent.*`    | Intent pipeline        | `vorion.intent.submit`, `vorion.intent.execute`  |
| `vorion.trust.*`     | Trust engine           | `vorion.trust.check`, `vorion.trust.signal`      |
| `vorion.proof.*`     | Proof plane            | `vorion.proof.commit`, `vorion.proof.flush`       |
| `vorion.gate.*`      | Gate admission         | `vorion.gate.admit`, `vorion.gate.revoke`         |
| `vorion.api.*`       | API layer (Cognigate)  | `vorion.api.request`, `vorion.api.auth`           |
| `vorion.pipeline.*`  | Full pipeline          | `vorion.pipeline.process`                        |

### Attribute conventions

| Attribute          | Type     | Description                          |
| ------------------ | -------- | ------------------------------------ |
| `agent.id`         | string   | The agent identifier                 |
| `intent.id`        | string   | The intent identifier                |
| `action.type`      | string   | Action type (read, write, execute)   |
| `action.resource`  | string   | Target resource                      |
| `trust.score`      | number   | Current trust score                  |
| `trust.tier`       | string   | Decision tier (GREEN/YELLOW/RED)     |
| `error.message`    | string   | Error message (set automatically)    |
| `error.type`       | string   | Error class name (set automatically) |

## API reference

### Interfaces

- `Span` — A single unit of work in a trace
- `Tracer` — Creates and finalizes spans

### Classes

- `NoopTracer` — Zero-overhead default (does nothing)
- `ConsoleTracer` — Logs spans as JSON to console
- `InMemoryTracer` — Stores spans in memory (testing)
- `TraceContext` — W3C Trace Context propagation

### Functions

- `getTracer()` / `setTracer(tracer)` / `resetTracer()` — Global tracer management
- `withSpan(name, fn, attributes?, parentSpanId?)` — Async span wrapper
- `withSpanSync(name, fn, attributes?, parentSpanId?)` — Sync span wrapper
- `generateTraceId()` / `generateSpanId()` — ID generators
- `extractTraceContext(headers)` / `injectTraceContext(ctx, headers)` — Header propagation
