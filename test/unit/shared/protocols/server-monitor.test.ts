import { describe, expect, it } from 'vitest';
import { serverMonitorProtocol } from '../../../../src/shared/protocols/server-monitor';

describe('serverMonitorProtocol', () => {
  it('accepts the state, processes, settings and status the host sends', () => {
    const state = {
      connectionName: 'Local',
      server: 'PostgreSQL',
      features: {
        processes: true,
        cancel: true,
        terminate: true,
        scopes: ['session'],
        serverScope: 'server',
      },
      readOnly: false,
    };
    expect(serverMonitorProtocol.webview.events.state.parse(state)).toEqual(state);
    const processes = {
      rows: [
        {
          id: '7',
          user: 'app',
          seconds: 1.5,
          query: 'SELECT 1',
          idle: false,
          mine: false,
          blockedBy: '8',
        },
      ],
      at: 1,
    };
    expect(serverMonitorProtocol.host.requests.processes.result.parse(processes)).toEqual(
      processes,
    );
    const settings = { rows: [{ name: 'work_mem', value: '4096', unit: 'kB', changed: true }] };
    expect(serverMonitorProtocol.host.requests.settings.result.parse(settings)).toEqual(settings);
    const status = {
      rows: [{ name: 'Questions', value: '10', group: 'g', perSecond: -2.5 }],
      summary: { version: '8.4', uptimeSeconds: 5, rate: { kind: 'queries', perSecond: 3 } },
      at: 2,
    };
    expect(serverMonitorProtocol.host.requests.status.result.parse(status)).toEqual(status);
  });

  it('limits what the page may ask for', () => {
    const { settings, stop } = serverMonitorProtocol.host.requests;
    expect(settings.params.parse({ scope: 'server' })).toEqual({ scope: 'server' });
    expect(() => settings.params.parse({ scope: 'global' })).toThrow();
    expect(stop.params.parse({ id: '23,4411', kind: 'terminate' })).toBeDefined();
    expect(() => stop.params.parse({ id: '1', kind: 'kill' })).toThrow();
    expect(() => stop.params.parse({ id: 'x'.repeat(1001), kind: 'cancel' })).toThrow();
    expect(() => stop.params.parse({ id: '1', kind: 'cancel', extra: true })).toThrow();
  });

  it('refuses states that do not add up', () => {
    const state = serverMonitorProtocol.webview.events.state;
    expect(() => state.parse({ connectionName: 'x' })).toThrow();
    expect(() =>
      state.parse({
        connectionName: 'x',
        readOnly: false,
        features: {
          processes: true,
          cancel: true,
          terminate: true,
          scopes: ['all'],
          serverScope: 'server',
        },
      }),
    ).toThrow();
  });
});
