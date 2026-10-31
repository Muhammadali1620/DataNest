// What the Tools page asks of the host, without the editor's API: the panel passes in how
// to save a file, so every rule here is covered by unit tests.

import { hashText } from '../../services/tools/hashing';
import { NetworkTools } from '../../services/tools/network';
import type { ToolsProtocol } from '../../shared/protocols/tools';
import type { ParamsOf, ResultOf } from '../../shared/rpc';

type Host = ToolsProtocol['host'];

export interface ToolsModelDeps {
  readonly network?: NetworkTools;
  /** Asks where to save and writes; the outcome says what happened. */
  readonly save: (
    suggestedName: string,
    extension: string,
    bytes: Uint8Array,
  ) => Promise<'saved' | 'cancelled' | 'failed'>;
}

/** A file name that is only a name: no folders, no characters a file system refuses. */
export function safeFileName(name: string, extension: string): string {
  const ext = extension.replace(/[^A-Za-z0-9]/gu, '').slice(0, 10) || 'bin';
  const base = name
    .replace(/\.[A-Za-z0-9]{1,10}$/u, '')
    .replace(/[\\/:*?"<>|]/gu, '_')
    .replace(/^\.+/u, '')
    .trim()
    .slice(0, 120);
  return `${base === '' ? 'file' : base}.${ext}`;
}

export class ToolsModel {
  private readonly network: NetworkTools;

  constructor(private readonly deps: ToolsModelDeps) {
    this.network = deps.network ?? new NetworkTools();
  }

  hash({ text }: ParamsOf<Host, 'hash'>): ResultOf<Host, 'hash'> {
    return hashText(text);
  }

  interfaces(): ResultOf<Host, 'interfaces'> {
    return { items: this.network.interfaces() };
  }

  async portCheck(params: ParamsOf<Host, 'portCheck'>): Promise<ResultOf<Host, 'portCheck'>> {
    return await this.network.portCheck(params.host, params.port, params.timeoutMs);
  }

  async dnsLookup(params: ParamsOf<Host, 'dnsLookup'>): Promise<ResultOf<Host, 'dnsLookup'>> {
    return await this.network.dnsLookup(params.host);
  }

  async tcpPing(params: ParamsOf<Host, 'tcpPing'>): Promise<ResultOf<Host, 'tcpPing'>> {
    return await this.network.tcpPing(params.host, params.port, params.count, params.timeoutMs);
  }

  async saveFile(params: ParamsOf<Host, 'saveFile'>): Promise<ResultOf<Host, 'saveFile'>> {
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(params.base64) || params.base64.length % 4 === 1) {
      return { ok: false, error: 'invalid' };
    }
    const bytes = Buffer.from(params.base64, 'base64');
    const outcome = await this.deps.save(
      safeFileName(params.suggestedName, params.extension),
      params.extension.replace(/[^A-Za-z0-9]/gu, '') || 'bin',
      bytes,
    );
    return outcome === 'saved' ? { ok: true } : { ok: false, error: outcome };
  }
}
