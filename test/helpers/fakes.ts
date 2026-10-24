import type { Logger, LogLevel, LogSink } from '../../src/core/logging/logger';

/** Collects lines written by a SinkLogger. */
export class MemorySink implements LogSink {
  readonly lines: string[] = [];

  appendLine(line: string): void {
    this.lines.push(line);
  }

  get text(): string {
    return this.lines.join('\n');
  }
}

export interface LoggedEntry {
  readonly level: LogLevel;
  readonly scope: readonly string[];
  readonly message: string;
  readonly error?: unknown;
}

/** A Logger that records calls instead of formatting them. */
export class RecordingLogger implements Logger {
  constructor(
    readonly entries: LoggedEntry[] = [],
    private readonly scope: readonly string[] = [],
  ) {}

  error(message: string, error?: unknown): void {
    this.entries.push({ level: 'error', scope: this.scope, message, error });
  }

  warn(message: string, error?: unknown): void {
    this.entries.push({ level: 'warn', scope: this.scope, message, error });
  }

  info(message: string): void {
    this.entries.push({ level: 'info', scope: this.scope, message });
  }

  debug(message: string): void {
    this.entries.push({ level: 'debug', scope: this.scope, message });
  }

  child(scope: string): RecordingLogger {
    return new RecordingLogger(this.entries, [...this.scope, scope]);
  }

  messages(level?: LogLevel): string[] {
    return this.entries
      .filter((e) => level === undefined || e.level === level)
      .map((e) => e.message);
  }
}
