// Small helpers of the RabbitMQ page (V13.26): how the counts are drawn and how the headers
// of a message to publish are read.

/** The width, 0–100, of one part of a queue's bar next to the whole. */
export function sharePercent(part: number, whole: number): number {
  if (whole <= 0 || part <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((part * 100) / whole));
}

/** `name: value` lines → headers; blank lines are skipped, a line without a colon is a name. */
export function parseHeaders(text: string): { name: string; value: string }[] {
  const headers: { name: string; value: string }[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') {
      continue;
    }
    const colon = line.indexOf(':');
    headers.push(
      colon < 0
        ? { name: line.trim(), value: '' }
        : { name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() },
    );
  }
  return headers;
}

/** The name the page shows: the default exchange has none. */
export function displayName(name: string, defaultLabel: string): string {
  return name === '' ? defaultLabel : name;
}

/** The colour class of a queue state: `running` and `idle` are fine, anything else is not. */
export function stateTone(state: string): 'success' | 'warning' | 'error' | 'outline' {
  switch (state) {
    case 'running':
    case 'idle':
      return 'success';
    case 'flow':
    case 'minority':
      return 'warning';
    case 'down':
    case 'crashed':
    case 'stopped':
      return 'error';
    default:
      return 'outline';
  }
}
