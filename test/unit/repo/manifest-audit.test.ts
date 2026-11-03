import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJson, ROOT } from '../../helpers/repo';

// A whole-manifest audit (V14.1): what package.json promises must exist in the code, and what the
// code sets must be what the menus ask for. Each check names the offenders, so a failure says
// what to fix.

interface Command {
  command: string;
  title?: string;
  category?: string;
}
interface MenuItem {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}
interface Manifest {
  contributes: {
    commands: Command[];
    menus?: Record<string, MenuItem[]>;
    submenus?: { id: string }[];
    keybindings?: { command: string; key: string; when?: string }[];
    configuration?:
      | { properties?: Record<string, Record<string, unknown>> }
      | { properties?: Record<string, Record<string, unknown>> }[];
    views?: Record<string, { id: string; when?: string }[]>;
    viewsWelcome?: { view: string; when?: string }[];
  };
}

const manifest = readJson('package.json') as Manifest;
const contributes = manifest.contributes;
const commands = contributes.commands.map((entry) => entry.command);
const menus = contributes.menus ?? {};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return path.endsWith('.ts') ? [path] : [];
  });
}

const source = sourceFiles(join(ROOT, 'src'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');

const BUILT_IN = /^(workbench|editor|vscode|notebook|search|explorer)\./;

function whenClauses(): { where: string; when: string }[] {
  const found: { where: string; when: string }[] = [];
  for (const [menu, items] of Object.entries(menus)) {
    for (const item of items) {
      if (item.when !== undefined) {
        found.push({ where: `${menu} → ${item.command ?? item.submenu ?? '?'}`, when: item.when });
      }
    }
  }
  for (const key of contributes.keybindings ?? []) {
    if (key.when !== undefined) {
      found.push({ where: `keybinding ${key.key}`, when: key.when });
    }
  }
  for (const views of Object.values(contributes.views ?? {})) {
    for (const view of views) {
      if (view.when !== undefined) {
        found.push({ where: `view ${view.id}`, when: view.when });
      }
    }
  }
  for (const welcome of contributes.viewsWelcome ?? []) {
    if (welcome.when !== undefined) {
      found.push({ where: `welcome ${welcome.view}`, when: welcome.when });
    }
  }
  return found;
}

describe('the manifest and the code agree (V14.1)', () => {
  it('has a registered handler (a command id in the sources) for every contributed command', () => {
    const missing = commands.filter(
      (command) => !new RegExp(`['"\`]${command.replace(/\./g, '\\.')}['"\`]`).test(source),
    );
    expect(missing).toEqual([]);
  });

  it('contributes every command once, with a title', () => {
    const duplicates = commands.filter((command, index) => commands.indexOf(command) !== index);
    expect(duplicates).toEqual([]);
    const untitled = contributes.commands.filter(
      (entry) => entry.title === undefined || entry.title === '',
    );
    expect(untitled.map((entry) => entry.command)).toEqual([]);
  });

  it('offers only contributed commands, submenus and built-in ones in the menus', () => {
    const known = new Set(commands);
    const submenus = new Set((contributes.submenus ?? []).map((submenu) => submenu.id));
    const unknown: string[] = [];
    for (const [menu, items] of Object.entries(menus)) {
      for (const item of items) {
        if (
          item.command !== undefined &&
          !known.has(item.command) &&
          !BUILT_IN.test(item.command)
        ) {
          unknown.push(`${menu}: ${item.command}`);
        }
        if (item.submenu !== undefined && !submenus.has(item.submenu)) {
          unknown.push(`${menu}: submenu ${item.submenu}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it('binds keys only to contributed commands, and no key twice under the same condition', () => {
    const known = new Set(commands);
    const keys = contributes.keybindings ?? [];
    expect(keys.filter((key) => !known.has(key.command) && !BUILT_IN.test(key.command))).toEqual(
      [],
    );
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const key of keys) {
      const id = `${key.key} | ${key.when ?? ''}`;
      const other = seen.get(id);
      if (other !== undefined) {
        clashes.push(`${id}: ${other} and ${key.command}`);
      }
      seen.set(id, key.command);
    }
    expect(clashes).toEqual([]);
  });

  it('describes every setting and gives it a type and a default', () => {
    const sections = [contributes.configuration ?? []].flat();
    const problems: string[] = [];
    let count = 0;
    for (const section of sections) {
      for (const [name, setting] of Object.entries(section.properties ?? {})) {
        count += 1;
        if (setting.description === undefined && setting.markdownDescription === undefined) {
          problems.push(`${name}: no description`);
        }
        if (setting.type === undefined) {
          problems.push(`${name}: no type`);
        }
        if (!('default' in setting)) {
          problems.push(`${name}: no default`);
        }
      }
    }
    expect(count).toBeGreaterThan(20);
    expect(problems).toEqual([]);
  });

  it('asks in when-clauses only for context keys that the code sets or a setting provides', () => {
    // The ids of CONTEXT_KEYS in command-ids.ts, plus the settings (`config.…` is built in).
    const block = /CONTEXT_KEYS\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(source)?.[1] ?? '';
    const keys = new Set(
      [...block.matchAll(/'(datanest\.[\w.]+)'/g)].map((match) => match[1] ?? ''),
    );
    expect(keys.size).toBeGreaterThan(2);
    const settings = new Set(
      [contributes.configuration ?? []]
        .flat()
        .flatMap((section) => Object.keys(section.properties ?? {})),
    );
    const unknown: string[] = [];
    for (const { where, when } of whenClauses()) {
      // The tree item kinds (`viewItem == datanest.…`) are not context keys.
      // Nor are the ids of views (`view == datanest.…`), checked by the next test.
      const rest = when
        .replace(/viewItem\s*(==|=~|!=|!~)\s*[^\s&|)]+/g, '')
        .replace(/\bview\s*==\s*[\w.-]+/g, '');
      for (const match of rest.matchAll(/(?<![\w./])(datanest(?:\.\w+)+)/g)) {
        const key = match[1] ?? '';
        if (!keys.has(key) && !settings.has(key)) {
          unknown.push(`${where}: ${key}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it('asks only for views that are contributed', () => {
    const views = new Set(
      Object.values(contributes.views ?? {}).flatMap((list) => list.map((view) => view.id)),
    );
    const unknown: string[] = [];
    for (const { where, when } of whenClauses()) {
      for (const match of when.matchAll(/\bview\s*==\s*([\w.-]+)/g)) {
        const id = match[1] ?? '';
        if (!views.has(id)) {
          unknown.push(`${where}: ${id}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it('tells each item of a view menu which view it belongs to', () => {
    const without: string[] = [];
    for (const menu of ['view/title', 'view/item/context']) {
      for (const item of menus[menu] ?? []) {
        if (!/\bview\s*==/.test(item.when ?? '')) {
          without.push(`${menu}: ${item.command ?? item.submenu ?? '?'}`);
        }
      }
    }
    expect(without).toEqual([]);
  });
});
