// What the Tools page asks of the host, without the editor's API: the panel passes in how
// to save a file, so every rule here is covered by unit tests.

import { hostname } from 'node:os';
import { hashText } from '../../services/tools/hashing';
import { IcmpPing } from '../../services/tools/icmp-ping';
import { NetworkTools } from '../../services/tools/network';
import { OnlineTools } from '../../services/tools/online';
import { ProcessTools } from '../../services/tools/processes';
import type { ToolsAction, ToolsProtocol } from '../../shared/protocols/tools';
import type { ParamsOf, ResultOf } from '../../shared/rpc';
import { DOH_HOSTS } from '../../shared/tools/doh';
import {
  buildGroups,
  checkSetting,
  type ConfigProperty,
  knownIds,
  type SettingGroup,
} from '../../shared/tools/settings-map';
import { isIpv4, isIpv6 } from '../../shared/tools/validate';

type Host = ToolsProtocol['host'];

/** The extension's own settings, as the editor holds them. */
export interface SettingsAccess {
  /** `contributes.configuration` of package.json, flattened. */
  readonly properties: () => Readonly<Record<string, ConfigProperty>>;
  readonly read: (id: string) => unknown;
  /** Writes to the user's settings; `undefined` restores the default. */
  readonly write: (id: string, value: string | number | boolean | undefined) => Promise<void>;
}

export interface ToolsModelDeps {
  readonly network?: NetworkTools;
  readonly online?: OnlineTools;
  readonly icmp?: IcmpPing;
  readonly processes?: ProcessTools;
  readonly settings?: SettingsAccess;
  /** The buttons of the settings tab that act in the editor. */
  readonly actions?: Partial<Record<ToolsAction, () => Promise<void> | void>>;
  /** Asks "end this process?"; ends nothing without a yes. */
  readonly confirmKill?: (pid: number, name: string, force: boolean) => Promise<boolean>;
  /** Hands a ping line to the page. */
  readonly pingLine?: (line: { runId: number; text: string; reply: boolean; ms?: number }) => void;
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
  private readonly online: OnlineTools;
  private readonly icmp: IcmpPing;
  private readonly processTools: ProcessTools;

  constructor(private readonly deps: ToolsModelDeps) {
    this.network = deps.network ?? new NetworkTools();
    this.online = deps.online ?? new OnlineTools();
    this.icmp = deps.icmp ?? new IcmpPing();
    this.processTools = deps.processes ?? new ProcessTools();
  }

  dispose(): void {
    this.icmp.dispose();
  }

  hash({ text }: ParamsOf<Host, 'hash'>): ResultOf<Host, 'hash'> {
    return hashText(text);
  }

  interfaces(): ResultOf<Host, 'interfaces'> {
    return { items: this.network.interfaces(), hostname: hostname() };
  }

  async publicIp(): Promise<ResultOf<Host, 'publicIp'>> {
    return await this.online.publicIp();
  }

  async dohLookup(params: ParamsOf<Host, 'dohLookup'>): Promise<ResultOf<Host, 'dohLookup'>> {
    return await this.online.dohLookup(params.host, params.type, params.provider);
  }

  /** Pings with the system program; with `doh` the name is first resolved over HTTPS. */
  async icmpPing(params: ParamsOf<Host, 'icmpPing'>): Promise<ResultOf<Host, 'icmpPing'>> {
    const emit = (text: string, reply = false, ms?: number): void => {
      this.deps.pingLine?.({
        runId: params.runId,
        text,
        reply,
        ...(ms === undefined ? {} : { ms }),
      });
    };
    let target = params.host.trim();
    let resolved: string | undefined;
    if (params.resolve === 'doh' && !isIpv4(target) && !isIpv6(target)) {
      let answer = await this.online.dohLookup(target, 'A', params.provider);
      if (answer.records.length === 0 && answer.error !== 'invalid-host') {
        answer = await this.online.dohLookup(target, 'AAAA', params.provider);
      }
      const address = answer.records.find(
        (record) => record.type === 'A' || record.type === 'AAAA',
      );
      if (address === undefined) {
        return { available: true, attempts: [], error: answer.error ?? 'not-found' };
      }
      resolved = address.data;
      emit(`${target} → ${resolved} (${DOH_HOSTS[params.provider]})`);
      target = resolved;
    }
    const result = await this.icmp.run(
      params.runId,
      target,
      params.count,
      params.timeoutMs,
      (line) => {
        emit(line.text, line.reply, line.ms);
      },
    );
    return {
      available: result.available,
      attempts: result.attempts,
      ...(resolved === undefined ? {} : { resolved }),
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  }

  icmpCancel({ runId }: ParamsOf<Host, 'icmpCancel'>): void {
    this.icmp.cancel(runId);
  }

  async processes(): Promise<ResultOf<Host, 'processes'>> {
    try {
      return await this.processTools.list();
    } catch {
      return {
        platform: process.platform,
        currentUser: '',
        items: [],
        truncated: false,
        error: 'failed',
      };
    }
  }

  async killProcess(params: ParamsOf<Host, 'killProcess'>): Promise<ResultOf<Host, 'killProcess'>> {
    // Ask first, and only for a process the tools would end at all.
    const probe = this.processTools.check(params.pid);
    if (probe !== undefined) {
      return { ok: false, error: probe };
    }
    const confirmed =
      (await this.deps.confirmKill?.(params.pid, params.name, params.force)) ?? false;
    if (!confirmed) {
      return { ok: false, error: 'cancelled' };
    }
    return this.processTools.kill(params.pid, params.force);
  }

  // ---- Settings

  settingsGroups(): SettingGroup[] {
    const access = this.deps.settings;
    return access === undefined ? [] : buildGroups(access.properties(), access.read);
  }

  settingsList(): ResultOf<Host, 'settingsList'> {
    return { groups: this.settingsGroups() };
  }

  async settingsSet(params: ParamsOf<Host, 'settingsSet'>): Promise<ResultOf<Host, 'settingsSet'>> {
    const access = this.deps.settings;
    if (access === undefined) {
      return { ok: false };
    }
    const checked = checkSetting(access.properties(), params.id, params.value);
    if (!checked.ok) {
      return { ok: false };
    }
    await access.write(params.id, checked.value);
    return { ok: true };
  }

  async settingsReset(
    params: ParamsOf<Host, 'settingsReset'>,
  ): Promise<ResultOf<Host, 'settingsReset'>> {
    const access = this.deps.settings;
    if (access === undefined) {
      return { ok: false };
    }
    const allowed = new Set(knownIds(access.properties()));
    for (const id of params.ids.filter((candidate) => allowed.has(candidate))) {
      await access.write(id, undefined);
    }
    return { ok: true };
  }

  async runAction({ action }: ParamsOf<Host, 'runAction'>): Promise<ResultOf<Host, 'runAction'>> {
    const run = this.deps.actions?.[action];
    if (run === undefined) {
      return { ok: false };
    }
    await run();
    return { ok: true };
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
