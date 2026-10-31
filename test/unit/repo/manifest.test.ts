import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_EDITOR } from '../../../scripts/build-config.mjs';
import { readJson, ROOT } from '../../helpers/repo';

interface Manifest {
  name: string;
  publisher: string;
  version: string;
  license: string;
  repository: { type: string; url: string };
  bugs: { url: string };
  main: string;
  type?: string;
  l10n?: string;
  icon?: string;
  engines: { vscode: string };
  activationEvents: string[];
  devDependencies: Record<string, string>;
  dependencies?: Record<string, string>;
  contributes: {
    viewsContainers: { activitybar: { id: string; title: string; icon: string }[] };
    views: Record<string, { id: string; name: string }[]>;
    viewsWelcome?: { view: string; contents: string }[];
  };
}

const manifest = readJson('package.json') as Manifest;
const nls = readJson('package.nls.json') as Record<string, string>;
const nlsRu = readJson('package.nls.ru.json') as Record<string, string>;

function placeholders(value: unknown): string[] {
  const json = JSON.stringify(value);
  return [...json.matchAll(/"%([^"%]+)%"/g)].map((match) => match[1] ?? '');
}

function minVersion(range: string): number[] {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!match) {
    throw new Error(`No version in "${range}"`);
  }
  return match.slice(1).map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

describe('package.json manifest', () => {
  it('identifies the extension as datanest (D11)', () => {
    expect(manifest.name).toBe('datanest');
    expect(manifest.publisher).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('ships an icon the Marketplace can show', () => {
    expect(manifest.icon).toBe('resources/icon.png');
    expect(existsSync(join(ROOT, manifest.icon ?? ''))).toBe(true);
  });

  it('is MIT-licensed and ships the license file', () => {
    expect(manifest.license).toBe('MIT');
    expect(existsSync(join(ROOT, 'LICENSE'))).toBe(true);
  });

  it('links the GitHub repository so vsce can rewrite README links', () => {
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'https://github.com/Muhammadali1620/DataNest.git',
    });
    expect(manifest.bugs.url).toBe('https://github.com/Muhammadali1620/DataNest/issues');
  });

  it('points main to the CommonJS bundle (D7)', () => {
    expect(manifest.main).toBe('./dist/extension.js');
    // "type": "module" would make Node treat dist/extension.js as ESM.
    expect(manifest.type).toBeUndefined();
  });

  it('supports the minimum editor chosen in V0.12 and newer (D23)', () => {
    expect(manifest.engines.vscode).toBe(`^${MIN_EDITOR.vscode}`);
  });

  it('uses @types/vscode not newer than engines.vscode (vsce rejects that)', () => {
    const types = manifest.devDependencies['@types/vscode'];
    expect(types).toBeDefined();
    expect(
      compareVersions(minVersion(types ?? ''), minVersion(manifest.engines.vscode)),
    ).toBeLessThanOrEqual(0);
  });

  it('never activates on startup', () => {
    for (const event of manifest.activationEvents) {
      expect(event).not.toBe('*');
      expect(event).not.toBe('onStartupFinished');
    }
  });

  it('has no runtime dependencies with native code markers', () => {
    const deps = Object.keys(manifest.dependencies ?? {});
    const nativeMarkers = ['node-gyp', 'bindings', 'node-addon-api', 'prebuild-install'];
    expect(deps.filter((dep) => nativeMarkers.includes(dep))).toEqual([]);
  });

  describe('contributes', () => {
    const containers = manifest.contributes.viewsContainers.activitybar;
    const views = Object.entries(manifest.contributes.views);

    it('declares the DataNest activity bar container with an existing icon', () => {
      expect(containers.map((c) => c.id)).toEqual(['datanest']);
      for (const container of containers) {
        expect(existsSync(join(ROOT, container.icon))).toBe(true);
      }
    });

    it('places every view into a declared container', () => {
      const ids = new Set(containers.map((c) => c.id));
      for (const [containerId] of views) {
        expect(ids.has(containerId)).toBe(true);
      }
    });

    it('prefixes every view id with "datanest."', () => {
      for (const [, list] of views) {
        for (const view of list) {
          expect(view.id).toMatch(/^datanest\.[a-zA-Z]+(\.[a-zA-Z]+)*$/);
        }
      }
    });

    it('has unique view ids', () => {
      const ids = views.flatMap(([, list]) => list.map((view) => view.id));
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('attaches welcome content only to existing views', () => {
      const ids = new Set(views.flatMap(([, list]) => list.map((view) => view.id)));
      for (const welcome of manifest.contributes.viewsWelcome ?? []) {
        expect(ids.has(welcome.view)).toBe(true);
      }
    });
  });

  describe('localization', () => {
    const used = placeholders(manifest);

    it('uses placeholders instead of hard-coded UI strings', () => {
      const { contributes } = manifest;
      const titles = [
        ...contributes.viewsContainers.activitybar.map((c) => c.title),
        ...Object.values(contributes.views).flatMap((list) => list.map((v) => v.name)),
        ...(contributes.viewsWelcome ?? []).map((w) => w.contents),
      ];
      for (const title of titles) {
        expect(title).toMatch(/^%.+%$/);
      }
    });

    it('defines every placeholder in package.nls.json', () => {
      expect(used.filter((key) => !(key in nls))).toEqual([]);
    });

    it('has no unused keys in package.nls.json', () => {
      expect(Object.keys(nls).filter((key) => !used.includes(key))).toEqual([]);
    });

    it('has the same keys in the Russian translation', () => {
      expect(Object.keys(nlsRu).sort()).toEqual(Object.keys(nls).sort());
    });

    it('has no empty translations', () => {
      for (const value of [...Object.values(nls), ...Object.values(nlsRu)]) {
        expect(value.trim()).not.toBe('');
      }
    });

    it('points l10n to an existing folder', () => {
      expect(manifest.l10n).toBeDefined();
      expect(existsSync(join(ROOT, manifest.l10n ?? ''))).toBe(true);
    });
  });
});

// V11.6: long context menus of the tree are grouped into submenus.
describe('tree submenus', () => {
  interface MenuEntry {
    command?: string;
    submenu?: string;
    group?: string;
    when?: string;
  }
  const contributes = (readJson('package.json') as { contributes: Record<string, unknown> })
    .contributes as {
    submenus: { id: string; label: string }[];
    menus: Record<string, MenuEntry[]>;
    commands: { command: string }[];
  };
  const ru = readJson('package.nls.ru.json') as Record<string, string>;
  const viewItems = (when = ''): string[] => when.match(/viewItem == [\w.]+/g) ?? [];

  it('names every submenu in English and Russian', () => {
    expect(contributes.submenus.map((menu) => menu.id)).toEqual([
      'datanest.tree.generate',
      'datanest.tree.data',
    ]);
    for (const menu of contributes.submenus) {
      const key = /^%(.+)%$/.exec(menu.label)?.[1] ?? '';
      expect(nls[key], menu.id).toBeTruthy();
      expect(ru[key], menu.id).toBeTruthy();
    }
  });

  it('shows each submenu wherever one of its items applies, and only in the tree', () => {
    const tree = contributes.menus['view/item/context'] ?? [];
    for (const { id } of contributes.submenus) {
      const entry = tree.find((item) => item.submenu === id);
      expect(entry, id).toBeDefined();
      expect(entry?.when).toMatch(/^view == datanest\.connections && /);
      const items = contributes.menus[id] ?? [];
      expect(items.length, id).toBeGreaterThan(1);
      for (const item of items) {
        expect(item.when).toMatch(/^view == datanest\.connections && /);
        for (const viewItem of viewItems(item.when)) {
          expect(viewItems(entry?.when), `${id}: ${item.command ?? ''}`).toContain(viewItem);
        }
      }
    }
  });

  it('lists only known commands in the submenus, and none of them in the menu itself too', () => {
    const known = new Set(contributes.commands.map((command) => command.command));
    const tree = contributes.menus['view/item/context'] ?? [];
    for (const { id } of contributes.submenus) {
      for (const item of contributes.menus[id] ?? []) {
        expect(known.has(item.command ?? ''), item.command).toBe(true);
        expect(tree.some((entry) => entry.command === item.command)).toBe(false);
      }
    }
  });

  it('links only real commands from the welcome view, the same ones in both languages', () => {
    const known = new Set(contributes.commands.map((command) => command.command));
    const links = (text = ''): string[] =>
      [...text.matchAll(/\(command:([\w.]+)\)/g)].map((match) => match[1] ?? '');
    const en = links(nls['viewsWelcome.connections.empty']);
    expect(en).toContain('datanest.connections.openSqliteFile');
    for (const command of en) {
      expect(known.has(command), command).toBe(true);
    }
    expect(links(ru['viewsWelcome.connections.empty'])).toEqual(en);
  });

  it('keeps Generate SELECT … DELETE and the data commands in their submenus', () => {
    const commands = (id: string): string[] =>
      (contributes.menus[id] ?? []).map((item) => item.command ?? '');
    expect(commands('datanest.tree.generate')).toEqual([
      'datanest.table.generateSelect',
      'datanest.table.generateInsert',
      'datanest.table.generateUpdate',
      'datanest.table.generateDelete',
    ]);
    expect(commands('datanest.tree.data')).toEqual(
      expect.arrayContaining([
        'datanest.dump.create',
        'datanest.table.exportData',
        'datanest.table.importData',
        'datanest.table.generateData',
        'datanest.table.transfer',
        'datanest.table.compareData',
        'datanest.mongo.exportCollection',
        'datanest.mongo.importCollection',
      ]),
    );
  });
});
