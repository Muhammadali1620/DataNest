import { describe, expect, it } from 'vitest';
import {
  MANAGER_SECTIONS,
  managerProtocol,
  prefixSide,
} from '../../../../src/shared/protocols/manager';
import { schemaCompareProtocol } from '../../../../src/shared/protocols/schema-compare';
import { serverMonitorProtocol } from '../../../../src/shared/protocols/server-monitor';

describe('prefixSide', () => {
  it('puts every request and event under the prefix and keeps the schemas', () => {
    const side = prefixSide(serverMonitorProtocol.host, 'monitor');
    expect(Object.keys(side.requests).sort()).toEqual(
      Object.keys(serverMonitorProtocol.host.requests)
        .map((name) => `monitor.${name}`)
        .sort(),
    );
    expect(side.requests['monitor.stop']).toBe(serverMonitorProtocol.host.requests.stop);
    expect(side.events['monitor.ready']).toBe(serverMonitorProtocol.host.events.ready);
  });

  it('copes with a side that has no requests', () => {
    expect(prefixSide(serverMonitorProtocol.webview, 'm').requests).toEqual({});
  });
});

describe('managerProtocol', () => {
  it('carries the server monitor and the schema comparison pages', () => {
    for (const name of Object.keys(serverMonitorProtocol.host.requests)) {
      expect(managerProtocol.host.requests).toHaveProperty(`monitor.${name}`);
    }
    for (const name of Object.keys(schemaCompareProtocol.host.requests)) {
      expect(managerProtocol.host.requests).toHaveProperty(`compare.${name}`);
    }
    expect(managerProtocol.webview.events).toHaveProperty('monitor.state');
    expect(managerProtocol.webview.events).toHaveProperty('compare.state');
    expect(managerProtocol.host.events).toHaveProperty('compare.swap');
    expect(managerProtocol.host.events).toHaveProperty('monitor.ready');
  });

  it('keeps its own names apart from the hosted pages', () => {
    expect(managerProtocol.host.events).toHaveProperty('ready');
    expect(managerProtocol.webview.events).toHaveProperty('state');
  });

  it('lists five sections', () => {
    expect(MANAGER_SECTIONS).toEqual(['log', 'dashboard', 'processes', 'dump', 'sync']);
  });

  it('checks the state of the page', () => {
    const state = managerProtocol.webview.events.state;
    const ok = {
      connectionId: 'c1',
      connectionName: 'Local',
      driver: 'postgres',
      sections: ['log', 'dump'],
      section: 'log',
      readOnly: false,
      production: false,
    };
    expect(state.parse(ok)).toEqual(ok);
    expect(() => state.parse({ ...ok, section: 'nope' })).toThrow();
    expect(() => state.parse({ ...ok, sections: ['nope'] })).toThrow();
    expect(() => state.parse({ ...ok, table: { name: 't', kind: 'index' } })).toThrow();
  });

  it('checks a dump request: a path is required and the content is one of three', () => {
    const params = managerProtocol.host.requests['dump.run'].params;
    const ok = {
      relations: ['a'],
      wholeScope: false,
      content: 'all',
      dropFirst: true,
      output: 'x.sql',
    };
    expect(params.parse(ok)).toEqual(ok);
    expect(() => params.parse({ ...ok, output: '' })).toThrow();
    expect(() => params.parse({ ...ok, content: 'both' })).toThrow();
  });
});
