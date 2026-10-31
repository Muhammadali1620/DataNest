// "Copy as cURL" (V10.2.7): the request under the cursor as a command for a POSIX shell,
// to share or to run elsewhere. Secrets stay out of it: with a user, curl asks for the
// password itself; an API key comes from the ELASTIC_API_KEY variable of the shell.

import type { ParsedRequest } from '../../core/elastic/requests';
import { type ConnectionConfig, effectivePort } from '../../shared/connection';

/** Quoted for sh: inside single quotes only `'` itself needs care. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The server's address as a URL, with the path prefix of a proxy in front of it. */
export function baseUrl(config: ConnectionConfig): string {
  const scheme = config.ssl === undefined ? 'http' : 'https';
  const host = config.host ?? 'localhost';
  const shown = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const port = effectivePort(config);
  const prefix = (config.elastic?.pathPrefix ?? '').replace(/\/+$/u, '');
  return `${scheme}://${shown}${port === undefined ? '' : `:${port}`}${prefix}`;
}

export function curlCommand(request: ParsedRequest, config: ConnectionConfig): string {
  const parts = ['curl', '-X', request.method, shellQuote(`${baseUrl(config)}${request.path}`)];
  if (config.ssl?.mode === 'require') {
    // "Encrypt only" in DataNest: the certificate is not checked, as curl's -k.
    parts.push('-k');
  } else if (config.ssl?.ca !== undefined && config.ssl.ca !== '') {
    parts.push('--cacert', shellQuote(config.ssl.ca));
  }
  if (config.elastic?.auth === 'apiKey') {
    parts.push('-H', '"Authorization: ApiKey ${ELASTIC_API_KEY}"');
  } else if (config.user !== undefined && config.user !== '') {
    parts.push('-u', shellQuote(config.user));
  }
  if (request.body !== undefined) {
    parts.push(
      '-H',
      shellQuote(`Content-Type: application/${request.ndjson ? 'x-ndjson' : 'json'}`),
      '--data-binary',
      // NDJSON must end with a newline, or the server waits for the last line.
      shellQuote(
        request.ndjson && !request.body.endsWith('\n') ? `${request.body}\n` : request.body,
      ),
    );
  }
  return parts.join(' ');
}
