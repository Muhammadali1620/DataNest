// Hashes of a text for the Tools page.

import { createHash } from 'node:crypto';

export interface TextHashes {
  readonly md5: string;
  readonly sha1: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** MD5, SHA-1 and SHA-256 of the text as UTF-8, in lower-case hex. */
export function hashText(text: string): TextHashes {
  const data = Buffer.from(text, 'utf8');
  const hex = (algorithm: string): string => createHash(algorithm).update(data).digest('hex');
  return { md5: hex('md5'), sha1: hex('sha1'), sha256: hex('sha256'), bytes: data.length };
}
