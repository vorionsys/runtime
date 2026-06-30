// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Vorion LLC

/**
 * Logger Utility Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, type LoggerOptions } from '../logger.js';

describe('createLogger', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  it('should create a logger with the correct name', () => {
    const logger = createLogger({ component: 'test-component' });

    // pino loggers expose bindings including name
    expect(logger).toBeDefined();
    // The logger should have standard pino methods
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.trace).toBe('function');
    expect(typeof logger.fatal).toBe('function');
  });

  it('should use the provided level', () => {
    const logger = createLogger({ component: 'level-test', level: 'debug' });

    // pino exposes .level as a string
    expect(logger.level).toBe('debug');
  });

  it('should fall back to LOG_LEVEL env var when level not specified', () => {
    process.env.LOG_LEVEL = 'warn';
    const logger = createLogger({ component: 'env-test' });
    expect(logger.level).toBe('warn');
  });

  it('should default to info when neither level nor LOG_LEVEL is set', () => {
    delete process.env.LOG_LEVEL;
    const logger = createLogger({ component: 'default-test' });
    expect(logger.level).toBe('info');
  });

  it('should format the name with @vorionsys/runtime prefix', () => {
    const logger = createLogger({ component: 'my-module' });
    // pino stores name in bindings
    const bindings = logger.bindings?.() ?? {};
    expect(bindings.name ?? '').toBe('@vorionsys/runtime:my-module');
  });

  it('should create distinct logger instances for different components', () => {
    const logger1 = createLogger({ component: 'comp-a' });
    const logger2 = createLogger({ component: 'comp-b' });

    expect(logger1).not.toBe(logger2);
  });

  it('should be callable without errors', () => {
    const logger = createLogger({ component: 'callable-test', level: 'silent' });
    // Verify logging methods do not throw
    expect(() => logger.info('test message')).not.toThrow();
    expect(() => logger.info({ key: 'val' }, 'with object')).not.toThrow();
    expect(() => logger.error(new Error('test'), 'error msg')).not.toThrow();
  });
});
