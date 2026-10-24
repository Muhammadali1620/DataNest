import type { Logger, LogLevel, LogSink } from '../../src/core/logging/logger';
import type { KeyValueState, SecretState } from '../../src/services/connection-store';

/** In-memory `vscode.Memento` substitute. */
export class FakeMemento implements KeyValueState {
  constructor(readonly data = new Map<string, unknown>()) {}

  get(key: string): unknown {
    return this.data.get(key);
  }

  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, value);
    }
    return Promise.resolve();
  }
}

/** In-memory `vscode.SecretStorage` substitute. */
export class FakeSecretStorage implements SecretState {
  constructor(readonly data = new Map<string, string>()) {}

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.data.get(key));
  }

  store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.data.delete(key);
    return Promise.resolve();
  }
}

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
