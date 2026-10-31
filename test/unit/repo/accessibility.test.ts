// Accessibility rules of the webview pages (V9.3) that a check of the repository can
// keep: the shared styles everywhere, and Svelte's accessibility warnings never silenced
// except where a page is a drawing surface on purpose.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFiles, readJson, ROOT } from '../../helpers/repo';

const apps = readdirSync(join(ROOT, 'webview', 'src', 'apps'));

/** `svelte-ignore` comments that silence accessibility checks, and why each may. */
const ALLOWED_IGNORES: Record<string, number> = {
  // The diagram is a canvas (role="application") with its own keys; a box is a drawn
  // shape, selected and opened by those keys as well as by the pointer.
  'webview/src/apps/er-diagram/App.svelte': 2,
  // The designer's canvas (role="application") is one drawing surface with its own keys
  // and the layer list beside it; shapes are picked by geometry, not by an element each.
  'webview/src/apps/tools/DesignerCanvas.svelte': 1,
};

describe('webview accessibility', () => {
  it.each(apps)('loads the shared styles in the %s page', (app) => {
    const main = readFileSync(join(ROOT, 'webview', 'src', 'apps', app, 'main.ts'), 'utf8');
    expect(main).toContain("import '../../styles/base.css';");
  });

  it('silences accessibility warnings only where the list above says why', () => {
    const found: Record<string, number> = {};
    for (const file of listFiles('webview/src').filter((path) => path.endsWith('.svelte'))) {
      const count = (
        readFileSync(join(ROOT, file), 'utf8').match(/svelte-ignore[^\n]*a11y_/gu) ?? []
      ).length;
      if (count > 0) {
        found[file] = count;
      }
    }
    expect(found).toEqual(ALLOWED_IGNORES);
  });

  it('fails the type check on any Svelte warning, accessibility ones included', () => {
    const { scripts } = readJson('package.json') as { scripts: Record<string, string> };
    expect(scripts.typecheck).toContain('svelte-check');
    expect(scripts.typecheck).toContain('--fail-on-warnings');
    expect(scripts.typecheck).toContain('--threshold warning');
  });
});

const css = readFileSync(join(ROOT, 'webview', 'src', 'styles', 'base.css'), 'utf8');

/** The declarations of the first rule whose selector contains `selector`. */
function rule(selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
}

describe('webview/src/styles/base.css', () => {
  it('shows keyboard focus everywhere in the theme focus colour', () => {
    expect(rule(':focus-visible')).toContain('outline: 1px solid var(--vscode-focusBorder)');
  });

  it('has a class that hides text from the eye but not from screen readers', () => {
    const hidden = rule('.sr-only');
    expect(hidden).toContain('position: absolute');
    expect(hidden).toContain('clip: rect(0, 0, 0, 0)');
    // display: none or visibility: hidden would hide it from screen readers too.
    expect(hidden).not.toMatch(/display:\s*none|visibility:\s*hidden/u);
  });

  it('outlines selected and current things in both high contrast themes', () => {
    const selector = css.slice(0, css.indexOf('{', css.indexOf("[aria-selected='true']")));
    expect(selector).toContain('.vscode-high-contrast');
    expect(selector).toContain('.vscode-high-contrast-light');
    for (const state of [
      "[aria-pressed='true']",
      "[aria-checked='true']",
      '.selected',
      '.current',
    ]) {
      expect(selector).toContain(state);
    }
    expect(rule("[aria-selected='true']")).toContain('var(--vscode-contrastActiveBorder');
  });

  it('marks changed, new and removed things without colour in high contrast', () => {
    expect(rule(':is(.changed, .inserted, .added)')).toContain('outline: 1px dotted');
    expect(rule(':is(.deleted, .removed)')).toContain('text-decoration: line-through');
  });
});
