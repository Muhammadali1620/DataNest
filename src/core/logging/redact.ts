// Logs must never contain passwords or tokens (ARCHITECTURE.md §8), even when a
// connection string, config object or SQL statement ends up in a message.

const MASK = '***';

// scheme://user:password@host
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]*):([^\s@/]*)@/gi;

// password=..., "password": "...", OPEN_VSX_TOKEN=..., apiKey: ...
const SECRET_PAIR =
  /(["']?)([\w-]*(?:password|passwd|pwd|secret|token|passphrase|api[_-]?key))\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"',;&}]+)/gi;

// CREATE USER ... IDENTIFIED BY 'x', ALTER ROLE ... PASSWORD 'x'
const SQL_PASSWORD = /\b(IDENTIFIED\s+BY|PASSWORD)(\s+)('(?:[^']|'')*'|"(?:[^"]|"")*")/gi;

/** Replaces credentials in free text with `***`. */
export function redactSecrets(text: string): string {
  return text
    .replace(URL_CREDENTIALS, `$1:${MASK}@`)
    .replace(
      SECRET_PAIR,
      (_match, quote: string, key: string, separator: string, value: string) => {
        const masked =
          value.startsWith('"') || value.startsWith("'") ? `${value[0]}${MASK}${value[0]}` : MASK;
        return `${quote}${key}${quote}${separator}${masked}`;
      },
    )
    .replace(SQL_PASSWORD, `$1$2'${MASK}'`);
}
