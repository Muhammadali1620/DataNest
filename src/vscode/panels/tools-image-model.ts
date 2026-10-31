// The host's part of the Tools page's picture and QR tools, without the editor's API:
// the TinyPNG key lives in SecretStorage (never on the page), and a link from a QR code is
// opened only after the user says yes.

import { TinyPng } from '../../services/tools/tinypng';
import type { ToolsProtocol } from '../../shared/protocols/tools';
import type { ParamsOf, ResultOf } from '../../shared/rpc';
import { base64ToBytes, bytesToBase64 } from '../../shared/tools/bytes';
import { isTinyKey } from '../../shared/tools/tinypng';

type Host = ToolsProtocol['host'];

export const TINY_KEY_SECRET = 'datanest.tools.tinypng';

export interface SecretsLike {
  get: (key: string) => PromiseLike<string | undefined>;
  store: (key: string, value: string) => PromiseLike<void>;
  delete: (key: string) => PromiseLike<void>;
}

export interface ImageToolsDeps {
  readonly secrets?: SecretsLike | undefined;
  readonly tiny?: TinyPng;
  /** Asks the user and opens the address; resolves to whether it was opened. */
  readonly openLink: (url: URL) => Promise<boolean>;
}

/** Only web addresses and mail links are worth opening from a picture. */
export function linkOf(text: string): URL | undefined {
  try {
    const url = new URL(text);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}

export class ImageTools {
  private readonly tiny: TinyPng;

  constructor(private readonly deps: ImageToolsDeps) {
    this.tiny = deps.tiny ?? new TinyPng();
  }

  async tinyStatus(): Promise<ResultOf<Host, 'tinyStatus'>> {
    const key = await this.deps.secrets?.get(TINY_KEY_SECRET);
    return { saved: key !== undefined && key !== '' };
  }

  async tinySaveKey({
    key,
  }: ParamsOf<Host, 'tinySaveKey'>): Promise<ResultOf<Host, 'tinySaveKey'>> {
    const clean = key.trim();
    if (!isTinyKey(clean) || this.deps.secrets === undefined) {
      return { ok: false, error: 'invalid' };
    }
    await this.deps.secrets.store(TINY_KEY_SECRET, clean);
    return { ok: true };
  }

  async tinyForgetKey(): Promise<ResultOf<Host, 'tinyForgetKey'>> {
    await this.deps.secrets?.delete(TINY_KEY_SECRET);
    return { ok: true };
  }

  async tinyCompress(
    params: ParamsOf<Host, 'tinyCompress'>,
  ): Promise<ResultOf<Host, 'tinyCompress'>> {
    const key = await this.deps.secrets?.get(TINY_KEY_SECRET);
    if (key === undefined || key === '') {
      return { ok: false, error: 'no-key' };
    }
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(params.base64);
    } catch {
      return { ok: false, error: 'unsupported' };
    }
    const result = await this.tiny.compress(key, bytes, params.mime);
    return result.ok
      ? {
          ok: true,
          base64: bytesToBase64(result.bytes),
          ...(result.count === undefined ? {} : { count: result.count }),
        }
      : { ok: false, error: result.error };
  }

  async openLink({ url }: ParamsOf<Host, 'openLink'>): Promise<ResultOf<Host, 'openLink'>> {
    const link = linkOf(url);
    return { opened: link === undefined ? false : await this.deps.openLink(link) };
  }
}
