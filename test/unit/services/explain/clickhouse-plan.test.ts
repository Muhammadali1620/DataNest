import { describe, expect, it } from 'vitest';
import { readClickhousePlan } from '../../../../src/services/explain/clickhouse-plan';
import { fixtureText } from '../../../helpers/fixtures';
import { outline } from '../../../helpers/plan-outline';

describe('readClickhousePlan', () => {
  it('reads the steps with their descriptions and the tables they read', () => {
    const plan = readClickhousePlan(fixtureText('explain', 'clickhouse-plan.json'));
    const lines = outline(plan);
    expect(lines[0]).toBe('Expression');
    expect(lines[1]).toBe('  Sorting !sort');
    expect(lines.filter((line) => line.includes('ReadFromMergeTree'))).toEqual([
      '                      ReadFromMergeTree [datanest_test.customers]',
      '                      ReadFromMergeTree [datanest_test.orders]',
      '                ReadFromMergeTree [datanest_test.order_items]',
    ]);
    expect(plan.root.detail).toBe('Project names');
    expect(plan.analyzed).toBe(false);
  });

  it('warns about a read that no index narrows, and lists the index figures', () => {
    const read = (indexes: unknown[], granules = 40) =>
      readClickhousePlan(
        JSON.stringify([
          {
            Plan: {
              'Node Type': 'ReadFromMergeTree',
              Description: 'db.t',
              Granules: granules,
              Indexes: indexes,
            },
          },
        ]),
      ).root;
    const all = read([
      { Type: 'PrimaryKey', Condition: 'true', 'Initial Granules': 40, 'Selected Granules': 40 },
    ]);
    expect(all.warnings).toEqual(['full-scan']);
    expect(all.properties).toContainEqual(['PrimaryKey', 'true; granules 40 of 40']);
    const narrowed = read([
      {
        Type: 'PrimaryKey',
        Condition: '(id in [5, 5])',
        'Initial Granules': 40,
        'Selected Granules': 1,
      },
    ]);
    expect(narrowed.warnings).toEqual([]);
    expect(read([], 1).warnings).toEqual([]);
  });

  it('refuses answers that are not a plan', () => {
    expect(() => readClickhousePlan('x')).toThrow('not JSON');
    expect(() => readClickhousePlan('[{}]')).toThrow('without a Plan');
  });
});
