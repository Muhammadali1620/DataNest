import { describe, expect, it } from 'vitest';
import { dataImportProtocol } from '../../../../src/shared/protocols/data-import';

const STATE = {
  driver: 'clickhouse',
  transactional: false,
  table: 'events.hits',
  file: 'hits.csv',
  size: 10,
  columns: [],
  options: { format: 'csv', delimiter: ',', header: true, emptyIsNull: true, nullText: '' },
  source: { columns: ['a'], rows: [{ line: 2, cells: ['1'] }] },
  mapping: [],
};

describe('dataImportProtocol state (V6.3)', () => {
  it('carries whether a stopped import can be undone', () => {
    expect(dataImportProtocol.webview.events.state.parse(STATE)).toEqual(STATE);
    expect(
      dataImportProtocol.webview.events.state.parse({ ...STATE, transactional: true }),
    ).toMatchObject({ transactional: true });
  });

  it('refuses a state without the flag or with a wrong one', () => {
    const { transactional: _flag, ...without } = STATE;
    expect(() => dataImportProtocol.webview.events.state.parse(without)).toThrow();
    expect(() =>
      dataImportProtocol.webview.events.state.parse({ ...STATE, transactional: 'no' }),
    ).toThrow();
  });

  it('knows ClickHouse among the drivers', () => {
    expect(() =>
      dataImportProtocol.webview.events.state.parse({ ...STATE, driver: 'db2' }),
    ).toThrow();
  });
});
