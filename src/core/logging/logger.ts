import { describeError } from '../errors';
import { redactSecrets } from './redact';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** From the most to the least important. */
export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Reads a level from user settings; anything unknown falls back to the default. */
export function parseLogLevel(value: unknown, fallback: LogLevel = DEFAULT_LOG_LEVEL): LogLevel {
  return isLogLevel(value) ? value : fallback;
}

/** What services and drivers depend on; they never see the output channel. */
export interface Logger {
  error(message: string, error?: unknown): void;
  warn(message: string, error?: unknown): void;
  info(message: string): void;
  debug(message: string): void;
  /** A logger that prefixes messages with `[scope]` and shares the level. */
  child(scope: string): Logger;
}

/** Where formatted lines go, e.g. `vscode.OutputChannel`. */
export interface LogSink {
  appendLine(line: string): void;
}

export interface SinkLoggerOptions {
  readonly sink: LogSink;
  readonly level?: LogLevel;
  /** Injected for tests. */
  readonly now?: () => Date;
}

interface SharedState {
  level: LogLevel;
  readonly sink: LogSink;
  readonly now: () => Date;
}

/** Formats, filters by level and redacts secrets before writing to the sink. */
export class SinkLogger implements Logger {
  private readonly state: SharedState;
  private readonly scopes: readonly string[];

  constructor(options: SinkLoggerOptions);
  constructor(options: SinkLoggerOptions, state: SharedState, scopes: readonly string[]);
  constructor(options: SinkLoggerOptions, state?: SharedState, scopes: readonly string[] = []) {
    this.state = state ?? {
      level: options.level ?? DEFAULT_LOG_LEVEL,
      sink: options.sink,
      now: options.now ?? (() => new Date()),
    };
    this.scopes = scopes;
  }

  get level(): LogLevel {
    return this.state.level;
  }

  /** Changes the level for this logger and all its children. */
  setLevel(level: LogLevel): void {
    this.state.level = level;
  }

  isEnabled(level: LogLevel): boolean {
    return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf(this.state.level);
  }

  error(message: string, error?: unknown): void {
    this.write('error', message, error);
  }

  warn(message: string, error?: unknown): void {
    this.write('warn', message, error);
  }

  info(message: string): void {
    this.write('info', message);
  }

  debug(message: string): void {
    this.write('debug', message);
  }

  child(scope: string): SinkLogger {
    return new SinkLogger({ sink: this.state.sink }, this.state, [...this.scopes, scope]);
  }

  private write(level: LogLevel, message: string, error?: unknown): void {
    if (!this.isEnabled(level)) {
      return;
    }
    const scope = this.scopes.map((name) => ` [${name}]`).join('');
    const details = error === undefined ? '' : `\n${describeError(error)}`;
    const line = `${this.state.now().toISOString()} [${level}]${scope} ${message}${details}`;
    this.state.sink.appendLine(redactSecrets(line));
  }
}
