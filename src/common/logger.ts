// SPDX-License-Identifier: Apache-2.0
// Copyright 2024-2026 Vorion LLC

/**
 * Logger utility for runtime package
 *
 * @packageDocumentation
 */

import pino from 'pino';

export interface LoggerOptions {
  component: string;
  level?: string;
}

export function createLogger(options: LoggerOptions): pino.Logger {
  return pino({
    name: `@vorionsys/runtime:${options.component}`,
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV !== 'production'
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
  });
}
