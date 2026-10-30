// Reading files of test/fixtures.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './repo';

export function fixtureText(...path: string[]): string {
  return readFileSync(join(ROOT, 'test', 'fixtures', ...path), 'utf8');
}

export function fixtureJson(...path: string[]): unknown {
  return JSON.parse(fixtureText(...path));
}
