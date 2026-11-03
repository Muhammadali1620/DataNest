// Rules of the look of the webview pages (V14.2) that a check of the repository can keep.
// jsdom cannot see CSS, so what went wrong on screen is pinned here at its source: the
// style rules of the pages and the shared sheets.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFiles, ROOT } from '../../helpers/repo';

interface Rule {
  readonly file: string;
  readonly selector: string;
  readonly body: string;
}

/** The plain `selector { declarations }` rules of the `<style>` blocks of the pages. */
function rulesOf(file: string): Rule[] {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const raw = file.endsWith('.css')
    ? text
    : (/<style[^>]*>([\s\S]*?)<\/style>/u.exec(text)?.[1] ?? '');
  const style = raw.replace(/\/\*[\s\S]*?\*\//gu, '');
  const found: Rule[] = [];
  for (const match of style.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    found.push({ file, selector: (match[1] ?? '').trim(), body: match[2] ?? '' });
  }
  return found;
}

const svelteFiles = listFiles('webview/src').filter((path) => path.endsWith('.svelte'));

describe('tone badges', () => {
  // A badge is a filled grey capsule. A rule that only recolours its text puts green,
  // orange or red on that grey (about 3:1, below the 4.5:1 of readable text), so a tone
  // badge must also take the grey away, as `.badge.success` of the shared sheet does.
  // These rules recolour text on a capsule that is already transparent (`outline`, `marked`).
  const ALREADY_TRANSPARENT = new Set([
    'webview/src/apps/schema-compare/App.svelte::.badge.status-added,',
    'webview/src/apps/schema-compare/App.svelte::.badge.status-removed,',
    'webview/src/apps/schema-compare/App.svelte::.badge.status-changed,',
    'webview/src/apps/schema-compare/App.svelte::.badge.status-same,',
  ]);

  it('also clear the background where a rule gives a badge a colour', () => {
    const offenders: string[] = [];
    for (const file of svelteFiles) {
      for (const rule of rulesOf(file)) {
        const names = rule.selector.split('\n')[0] ?? '';
        const badge = /\.badge\b|\.lease\.|\.kind\./u.test(rule.selector);
        const colours = /(^|[;\s])color:\s*(?!inherit)/u.test(rule.body);
        if (!badge || !colours || rule.body.includes('background')) {
          continue;
        }
        if (ALREADY_TRANSPARENT.has(`${file}::${names.trim()}`)) {
          continue;
        }
        offenders.push(`${file}: ${rule.selector.replace(/\s+/gu, ' ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the shared toolbar', () => {
  const sheet = rulesOf('webview/src/styles/controls.css');

  it('wraps, so a row of icon buttons never pushes a narrow page sideways', () => {
    const toolbar = sheet.find((rule) => rule.selector === '.toolbar');
    expect(toolbar?.body).toContain('flex-wrap: wrap');
    // `flex: none` would keep it as wide as all its buttons and so never let it wrap.
    expect(toolbar?.body).not.toContain('flex: none');
  });

  it('keeps the text for screen readers anchored, so it cannot stretch the page', () => {
    const hidden = rulesOf('webview/src/styles/base.css').find(
      (rule) => rule.selector === '.sr-only',
    );
    expect(hidden?.body).toContain('left: 0');
  });
});

describe('grids of cards', () => {
  it('never ask a column to be wider than a narrow page', () => {
    const offenders: string[] = [];
    for (const file of svelteFiles) {
      for (const rule of rulesOf(file)) {
        for (const match of rule.body.matchAll(/minmax\((\d+)px,/gu)) {
          if (Number(match[1]) >= 300) {
            offenders.push(`${file}: ${rule.selector} minmax(${match[1]}px, …)`);
          }
        }
      }
    }
    // `minmax(min(380px, 100%), 1fr)` is the form that shrinks with the page.
    expect(offenders).toEqual([]);
  });
});

describe('state colours of text', () => {
  const base = rulesOf('webview/src/styles/base.css');

  it('are darkened toward the text colour in a light theme, so they pass 4.5:1', () => {
    const light = base.find((rule) => rule.selector.includes('.vscode-light'));
    expect(light, 'no rule for the light themes').toBeDefined();
    for (const token of ['success', 'warning', 'danger', 'info', 'orange', 'purple']) {
      const line = new RegExp(`--dn-${token}:\\s*color-mix\\(([^;]*)\\);`, 'u').exec(
        light?.body ?? '',
      );
      expect(line?.[1], `--dn-${token}`).toContain('var(--vscode-foreground)');
    }
  });

  it('keep the muted text a little darker than the theme gives it', () => {
    const root = base.find((rule) => rule.selector === ':root');
    expect(root?.body).toMatch(/--dn-muted:\s*color-mix\([^;]*var\(--vscode-foreground\)/u);
  });

  it('never colour text with the raw chart or error colours (they are for fills and icons)', () => {
    const offenders: string[] = [];
    for (const file of svelteFiles) {
      for (const rule of rulesOf(file)) {
        if (rule.selector.includes('icon')) {
          continue; // an icon is a fill, not text
        }
        const lines = rule.body.split(';').map((line) => line.trim());
        const text = lines.find((line) =>
          /^color:\s*var\(--vscode-(charts-|errorForeground)/u.test(line),
        );
        if (text !== undefined) {
          offenders.push(`${file}: ${rule.selector.replace(/\s+/gu, ' ')} { ${text} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('high contrast themes', () => {
  const base = rulesOf('webview/src/styles/base.css');

  it('give a marked item that has the keyboard its own thicker ring', () => {
    const ring = base.find(
      (rule) =>
        rule.selector.includes('.vscode-high-contrast') && rule.selector.includes(':focus-visible'),
    );
    expect(ring?.body).toContain('outline: 2px solid var(--vscode-focusBorder)');
  });

  it.each([
    'webview/src/components/ContextMenu.svelte',
    'webview/src/components/MenuButton.svelte',
  ])('mark the chosen item of %s by the menu border, not only by a fill', (file) => {
    const item = rulesOf(file).find((rule) => rule.selector.includes('.item:focus'));
    expect(item?.body).toContain(
      'outline: 1px solid var(--vscode-menu-selectionBorder, transparent)',
    );
  });
});
