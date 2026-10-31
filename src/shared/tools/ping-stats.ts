// Summary of a series of TCP connect attempts (the Tools page's "ping").

export interface PingAttempt {
  readonly ok: boolean;
  /** Milliseconds to connect; present when `ok`. */
  readonly ms?: number | undefined;
}

export interface PingSummary {
  readonly sent: number;
  readonly received: number;
  readonly lost: number;
  /** 0–100, one decimal. */
  readonly lossPercent: number;
  readonly min?: number;
  readonly avg?: number;
  readonly max?: number;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

export function summarize(attempts: readonly PingAttempt[]): PingSummary {
  const times = attempts.flatMap((attempt) =>
    attempt.ok && attempt.ms !== undefined && Number.isFinite(attempt.ms) ? [attempt.ms] : [],
  );
  const sent = attempts.length;
  const received = times.length;
  const base = {
    sent,
    received,
    lost: sent - received,
    lossPercent: sent === 0 ? 0 : round1(((sent - received) / sent) * 100),
  };
  if (received === 0) {
    return base;
  }
  return {
    ...base,
    min: round1(Math.min(...times)),
    avg: round1(times.reduce((sum, value) => sum + value, 0) / received),
    max: round1(Math.max(...times)),
  };
}
