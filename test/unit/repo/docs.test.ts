// The documentation (V9.4) is checked against the code, so it cannot quietly go stale:
// links and anchors lead somewhere, every setting and shortcut is described, and the
// files the driver guide points at exist.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFiles, readJson, ROOT } from '../../helpers/repo';

/** Markdown the reader may follow: the guide, the FAQ, the contributor pages, README. */
const PAGES = [
  ...listFiles('docs').filter(
    (file) =>
      file.endsWith('.md') && !file.startsWith('docs/research/') && file !== 'docs/test-plan.md',
  ),
  'README.md',
  'CONTRIBUTING.md',
];

function read(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

/** Text without fenced code blocks, whose contents are not links or paths to check. */
function prose(text: string): string {
  return text.replace(/```[\s\S]*?```/gu, '');
}

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to dashes. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/gu, '-');
}

function anchors(file: string): Set<string> {
  return new Set(
    [...prose(read(file)).matchAll(/^#{1,6}\s+(.+)$/gmu)].map((match) => slug(match[1] ?? '')),
  );
}

interface Link {
  readonly from: string;
  readonly target: string;
  readonly anchor: string | undefined;
}

function links(): Link[] {
  return PAGES.flatMap((from) =>
    [...prose(read(from)).matchAll(/\]\(([^)\s]+)\)/gu)]
      .map((match) => match[1] ?? '')
      .filter((href) => !/^(https?:|mailto:)/u.test(href))
      .map((href) => {
        const [path = '', anchor] = href.split('#');
        const target =
          path === '' ? from : normalize(join(dirname(from), path)).replaceAll('\\', '/');
        return { from, target, anchor };
      }),
  );
}

describe('documentation', () => {
  it('has the pages the index promises', () => {
    const index = read('docs/index.md');
    for (const page of listFiles('docs/guide')) {
      expect(index, page).toContain(`](${relative('docs', page).replaceAll('\\', '/')})`);
    }
    expect(index).toContain('](faq.md)');
    expect(index).toContain('](contributing/adding-a-driver.md)');
  });

  it('links only to files that exist', () => {
    const broken = links().filter((link) => !existsSync(join(ROOT, link.target)));
    expect(broken).toEqual([]);
  });

  it('links only to headings that exist', () => {
    const broken = links().filter(
      (link) =>
        link.anchor !== undefined &&
        link.target.endsWith('.md') &&
        !anchors(link.target).has(link.anchor),
    );
    expect(broken).toEqual([]);
  });

  it('describes every setting with its default', () => {
    const { contributes } = readJson('package.json') as {
      contributes: { configuration: { properties: Record<string, { default: unknown }> } };
    };
    const page = read('docs/guide/settings.md');
    const rows = page.split('\n').filter((line) => line.startsWith('| `datanest.'));
    const missing = Object.entries(contributes.configuration.properties).filter(
      ([key, setting]) =>
        !rows.some(
          (row) =>
            row.startsWith(`| \`${key}\` |`) && row.includes(`\`${String(setting.default)}\``),
        ),
    );
    expect(missing.map(([key]) => key)).toEqual([]);
    expect(rows).toHaveLength(Object.keys(contributes.configuration.properties).length);
  });

  it('lists every keyboard shortcut of the manifest', () => {
    const { contributes } = readJson('package.json') as {
      contributes: { keybindings: { key: string; mac?: string }[] };
    };
    const page = read('docs/guide/keyboard.md');
    const written = (key: string): string =>
      key
        .split('+')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('+');
    for (const binding of contributes.keybindings) {
      expect(page, binding.key).toContain(`\`${written(binding.key)}\``);
      if (binding.mac !== undefined) {
        expect(page, binding.mac).toContain(`\`${written(binding.mac)}\``);
      }
    }
  });

  it('points the driver guide at files and folders that exist', () => {
    const guide = prose(read('docs/contributing/adding-a-driver.md'));
    const paths = [
      ...guide.matchAll(/`((?:src|test|scripts|webview|l10n|docker|\.github)\/[^`<>*\s]+)`/gu),
    ].map((match) => (match[1] ?? '').replace(/\/$/u, ''));
    expect(paths.length).toBeGreaterThan(20);
    expect(paths.filter((path) => !existsSync(join(ROOT, path)))).toEqual([]);
  });

  it('keeps the internal notes out of the published site', () => {
    const config = read('docs/_config.yml');
    expect(config).toMatch(/exclude:[\s\S]*- research/u);
    expect(config).toMatch(/exclude:[\s\S]*- test-plan\.md/u);
  });
});
