import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../../src/services/import/csv-parser';
import { toCsv } from '../../../src/shared/csv';
import { pick, pieces, seeded } from '../../helpers/fuzz';

const PARTS = [
  '',
  'a',
  'b c',
  ' ',
  '  x',
  'y ',
  ',',
  ';',
  '|',
  '\t',
  '"',
  '""',
  '\n',
  '\r',
  '\r\n',
  'é',
  '日本',
  '\u{1F600}',
  '1',
  '-0',
  'NULL',
  "'",
  '\\',
];

describe('CSV written by the exporter and read back by the importer', () => {
  for (const delimiter of [',', ';', '\t', '|']) {
    it(`gives back every row for the delimiter ${JSON.stringify(delimiter)}`, () => {
      const random = seeded(77 + delimiter.charCodeAt(0));
      for (let round = 0; round < 1500; round += 1) {
        const columns = 1 + Math.floor(random() * 4);
        const count = Math.floor(random() * 5);
        const rows: string[][] = Array.from({ length: count }, () =>
          Array.from({ length: columns }, () => pieces(random, PARTS, 4)),
        );
        const header = Array.from({ length: columns }, () =>
          pick(random, ['id', 'name', 'x y', '']),
        );
        const text = toCsv(rows, { header, delimiter });
        const read = parseCsv(text, delimiter).map((record) => record.fields);
        const label = `round ${round} ${JSON.stringify({ header, rows, text })}`;
        expect(read, label).toEqual([header, ...rows]);
      }
    });
  }
});
