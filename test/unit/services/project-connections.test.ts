import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  type ProjectFiles,
  type ProjectFolder,
  ProjectConnections,
  projectConnectionId,
  toAbsolute,
  toRelative,
} from '../../../src/services/project-connections';
import { RecordingLogger } from '../../helpers/fakes';

const ROOT = join('/', 'work', 'shop');
const SHOP: ProjectFolder = { key: 'file:///work/shop', name: 'shop', root: ROOT };
const BLOG: ProjectFolder = {
  key: 'file:///work/blog',
  name: 'blog',
  root: join('/', 'work', 'blog'),
};

/** Project files in memory, by folder key. */
class MemoryFiles implements ProjectFiles {
  readonly texts = new Map<string, string>();
  readonly writes: string[] = [];
  failRead = false;

  read(folder: ProjectFolder): Promise<string | undefined> {
    if (this.failRead) {
      return Promise.reject(new Error('disk on fire'));
    }
    return Promise.resolve(this.texts.get(folder.key));
  }

  write(folder: ProjectFolder, text: string): Promise<void> {
    this.texts.set(folder.key, text);
    this.writes.push(folder.key);
    return Promise.resolve();
  }

  json(
    folder: ProjectFolder,
  ): { connections: Record<string, unknown>[] } & Record<string, unknown> {
    return JSON.parse(this.texts.get(folder.key) ?? '{}') as {
      connections: Record<string, unknown>[];
    };
  }
}

function file(...connections: unknown[]): string {
  return JSON.stringify({ version: 1, connections });
}

async function setup(texts: Record<string, string> = {}, trusted = true) {
  const files = new MemoryFiles();
  for (const [key, text] of Object.entries(texts)) {
    files.texts.set(key, text);
  }
  const projects = new ProjectConnections({ files, logger: new RecordingLogger() });
  await projects.load([SHOP, BLOG], trusted);
  return { files, projects };
}

describe('projectConnectionId', () => {
  it('is stable for a folder and an id, and differs between folders', () => {
    const a = projectConnectionId(SHOP.key, 'dev');
    expect(projectConnectionId(SHOP.key, 'dev')).toBe(a);
    expect(projectConnectionId(BLOG.key, 'dev')).not.toBe(a);
    expect(a).toMatch(/^p-[0-9a-f]{8}-dev$/);
  });
});

describe('ProjectConnections.load', () => {
  it('lists the connections of every folder that has a file', async () => {
    const { projects } = await setup({
      [SHOP.key]: file({ id: 'dev', name: 'Dev', driver: 'mysql', host: 'h' }),
    });
    expect(projects.views().map((view) => view.folder.name)).toEqual(['shop']);
    expect(projects.list()).toEqual([
      { id: projectConnectionId(SHOP.key, 'dev'), name: 'Dev', driver: 'mysql', host: 'h' },
    ]);
    expect(projects.folders()).toEqual([SHOP, BLOG]);
    expect(projects.writableFolders()).toEqual([SHOP, BLOG]);
  });

  it('makes ids from names when the file has none, explicit ids first', async () => {
    const { projects } = await setup({
      [SHOP.key]: file(
        { name: 'Dev', driver: 'mysql', host: 'a' },
        { id: 'dev', name: 'Other', driver: 'mysql', host: 'b' },
        { name: 'Dev', driver: 'mysql', host: 'c' },
      ),
    });
    expect(
      projects.list().map((config) => [config.host, config.id.split('-').slice(2).join('-')]),
    ).toEqual([
      ['a', 'dev-2'],
      ['b', 'dev'],
      ['c', 'dev-3'],
    ]);
  });

  it('reports a repeated id and skips that entry', async () => {
    const { projects } = await setup({
      [SHOP.key]: file(
        { id: 'x', name: 'A', driver: 'mysql', host: 'a' },
        { id: 'x', name: 'B', driver: 'mysql', host: 'b' },
      ),
    });
    const [view] = projects.views();
    expect(view?.connections.map((config) => config.name)).toEqual(['A']);
    expect(view?.problems).toEqual([{ position: 2, problem: 'id "x" is used twice' }]);
  });

  it('reports broken entries by position and keeps the rest usable', async () => {
    const { projects } = await setup({
      [SHOP.key]: file(
        { name: 'Ok', driver: 'mysql', host: 'a' },
        { name: 'No host', driver: 'mysql' },
      ),
    });
    const [view] = projects.views();
    expect(view?.status).toBe('ok');
    expect(view?.listed).toBe(2);
    expect(view?.problems).toEqual([{ position: 2, problem: 'host-empty' }]);
  });

  it('marks a file that is not JSON as broken, without connections', async () => {
    const { projects } = await setup({ [SHOP.key]: '{ "connections": [' });
    const [view] = projects.views();
    expect(view?.status).toBe('broken');
    expect(view?.error).toBeDefined();
    expect(projects.list()).toEqual([]);
  });

  it('marks a folder whose file cannot be read as broken', async () => {
    const files = new MemoryFiles();
    files.failRead = true;
    const projects = new ProjectConnections({ files, logger: new RecordingLogger() });
    await projects.load([SHOP], true);
    expect(projects.views()[0]).toMatchObject({ status: 'broken', error: 'disk on fire' });
  });

  it('lists nothing from an untrusted workspace but says how much is there', async () => {
    const { projects } = await setup(
      { [SHOP.key]: file({ name: 'Dev', driver: 'mysql', host: 'h' }) },
      false,
    );
    expect(projects.list()).toEqual([]);
    expect(projects.views()).toEqual([
      { folder: SHOP, status: 'untrusted', connections: [], problems: [], listed: 1 },
    ]);
    expect(projects.writableFolders()).toEqual([]);
    await expect(projects.add(SHOP.key, { name: 'X', driver: 'mysql', host: 'h' })).rejects.toThrow(
      'Trust this workspace',
    );
  });

  it('resolves relative paths against the folder and leaves ~ and absolute ones alone', async () => {
    const elsewhere = join('/', 'etc', 'ca.pem');
    const { projects } = await setup({
      [SHOP.key]: file(
        { id: 'lite', name: 'Lite', driver: 'sqlite', file: 'data/dev.db' },
        {
          id: 'pg',
          name: 'Pg',
          driver: 'postgres',
          host: 'h',
          ssl: { mode: 'verify-ca', ca: elsewhere, cert: 'certs/c.pem', key: 'certs/c.key' },
          ssh: { host: 'b', user: 'u', auth: 'key', keyFile: '~/.ssh/id' },
        },
      ),
    });
    const [lite, pg] = projects.list();
    expect(lite?.file).toBe(join(ROOT, 'data/dev.db'));
    expect(pg?.ssl).toEqual({
      mode: 'verify-ca',
      ca: elsewhere,
      cert: join(ROOT, 'certs/c.pem'),
      key: join(ROOT, 'certs/c.key'),
    });
    expect(pg?.ssh?.keyFile).toBe('~/.ssh/id');
  });

  it('drops the folder field: the project is the folder', async () => {
    const { projects } = await setup({
      [SHOP.key]: file({ name: 'Dev', driver: 'mysql', host: 'h', folder: 'Work' }),
    });
    expect(projects.list()[0]).not.toHaveProperty('folder');
  });

  it('tells which folder holds a connection', async () => {
    const { projects } = await setup({
      [BLOG.key]: file({ id: 'b', name: 'B', driver: 'mysql', host: 'h' }),
    });
    expect(projects.folderOf(projectConnectionId(BLOG.key, 'b'))).toEqual(BLOG);
    expect(projects.folderOf('some-uuid')).toBeUndefined();
    expect(projects.get('some-uuid')).toBeUndefined();
  });

  it('reads every file again on reloadAll, keeping the trust it was loaded with', async () => {
    const { files, projects } = await setup();
    expect(projects.views()).toEqual([]);
    files.texts.set(BLOG.key, file({ id: 'b', name: 'B', driver: 'mysql', host: 'h' }));
    await projects.reloadAll();
    expect(projects.list().map((config) => config.id)).toEqual([
      projectConnectionId(BLOG.key, 'b'),
    ]);
  });

  it('forgets a file that was deleted', async () => {
    const { files, projects } = await setup({
      [SHOP.key]: file({ name: 'A', driver: 'mysql', host: 'h' }),
    });
    files.texts.delete(SHOP.key);
    await projects.reload(SHOP.key);
    expect(projects.views()).toEqual([]);
    await projects.reload('file:///not-open');
    expect(projects.views()).toEqual([]);
  });

  it('notifies listeners after loading, and survives a failing listener', async () => {
    const { projects } = await setup();
    const seen = vi.fn();
    projects.onDidChange(() => {
      throw new Error('boom');
    });
    projects.onDidChange(seen);
    await projects.reload(SHOP.key);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('ProjectConnections changes', () => {
  it('adds a connection to a new file with an id made from its name', async () => {
    const { files, projects } = await setup();
    const added = await projects.add(SHOP.key, { name: 'Staging EU', driver: 'mysql', host: 'h' });
    expect(added.id).toBe(projectConnectionId(SHOP.key, 'staging-eu'));
    expect(files.json(SHOP)).toEqual({
      version: 1,
      connections: [{ id: 'staging-eu', name: 'Staging EU', driver: 'mysql', host: 'h' }],
    });
    expect(projects.views().map((view) => view.folder.key)).toEqual([SHOP.key]);
  });

  it('writes paths inside the folder relative, with forward slashes', async () => {
    const { files, projects } = await setup();
    await projects.add(SHOP.key, {
      name: 'Lite',
      driver: 'sqlite',
      file: join(ROOT, 'data', 'dev.db'),
    });
    expect(files.json(SHOP).connections[0]?.file).toBe('data/dev.db');
    expect(projects.list()[0]?.file).toBe(join(ROOT, 'data', 'dev.db'));
  });

  it('updates an entry in place, keeps its id and the entries it cannot read', async () => {
    const { files, projects } = await setup({
      [SHOP.key]: JSON.stringify({
        $schema: 'x',
        note: 'keep me',
        connections: [
          { id: 'dev', name: 'Dev', driver: 'mysql', host: 'a' },
          { name: 'From a newer DataNest', driver: 'mysql', host: 'b', futureField: 1 },
        ],
      }),
    });
    const id = projectConnectionId(SHOP.key, 'dev');
    const updated = await projects.update(id, { name: 'Dev 2', driver: 'mysql', host: 'c' });
    expect(updated).toEqual({ id, name: 'Dev 2', driver: 'mysql', host: 'c' });
    expect(files.json(SHOP)).toEqual({
      $schema: 'x',
      version: 1,
      note: 'keep me',
      connections: [
        { id: 'dev', name: 'Dev 2', driver: 'mysql', host: 'c' },
        { name: 'From a newer DataNest', driver: 'mysql', host: 'b', futureField: 1 },
      ],
    });
  });

  it('keeps the derived id of an entry without one, so its secrets stay found', async () => {
    const { files, projects } = await setup({
      [SHOP.key]: file({ name: 'Dev', driver: 'mysql', host: 'a' }),
    });
    const id = projectConnectionId(SHOP.key, 'dev');
    await projects.update(id, { name: 'Renamed', driver: 'mysql', host: 'a' });
    expect(files.json(SHOP).connections[0]?.id).toBe('dev');
    expect(projects.get(id)?.name).toBe('Renamed');
  });

  it('finds the entry by id when the file changed since it was read', async () => {
    const { files, projects } = await setup({
      [SHOP.key]: file({ id: 'dev', name: 'Dev', driver: 'mysql', host: 'a' }),
    });
    // A teammate's pull put a connection in front of ours; no reload happened yet.
    files.texts.set(
      SHOP.key,
      file(
        { id: 'new', name: 'New', driver: 'mysql', host: 'n' },
        { id: 'dev', name: 'Dev', driver: 'mysql', host: 'a' },
      ),
    );
    await projects.update(projectConnectionId(SHOP.key, 'dev'), {
      name: 'Dev',
      driver: 'mysql',
      host: 'changed',
    });
    expect(files.json(SHOP).connections.map((entry) => entry.host)).toEqual(['n', 'changed']);
  });

  it('removes an entry and keeps the rest', async () => {
    const { files, projects } = await setup({
      [SHOP.key]: file(
        { id: 'a', name: 'A', driver: 'mysql', host: 'a' },
        { id: 'b', name: 'B', driver: 'mysql', host: 'b' },
      ),
    });
    await projects.remove(projectConnectionId(SHOP.key, 'a'));
    expect(files.json(SHOP).connections.map((entry) => entry.id)).toEqual(['b']);
    expect(projects.list().map((config) => config.name)).toEqual(['B']);
  });

  it('refuses to change an unknown connection or one that left the file', async () => {
    const { files, projects } = await setup({
      [SHOP.key]: file({ id: 'a', name: 'A', driver: 'mysql', host: 'a' }),
    });
    await expect(projects.remove('nope')).rejects.toMatchObject({ code: 'not-found' });
    files.texts.set(SHOP.key, file());
    await expect(projects.remove(projectConnectionId(SHOP.key, 'a'))).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('refuses to write over a file that does not read, and to add to an unknown folder', async () => {
    const { files, projects } = await setup({
      [SHOP.key]: file({ id: 'a', name: 'A', driver: 'mysql', host: 'a' }),
    });
    files.texts.set(SHOP.key, '{ broken');
    await expect(
      projects.update(projectConnectionId(SHOP.key, 'a'), {
        name: 'A',
        driver: 'mysql',
        host: 'x',
      }),
    ).rejects.toThrow('cannot be read');
    expect(files.texts.get(SHOP.key)).toBe('{ broken');
    await expect(
      projects.add('file:///elsewhere', { name: 'X', driver: 'mysql', host: 'h' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('runs writes one after another, so two adds do not lose each other', async () => {
    const { files, projects } = await setup();
    await Promise.all([
      projects.add(SHOP.key, { name: 'One', driver: 'mysql', host: 'a' }),
      projects.add(SHOP.key, { name: 'Two', driver: 'mysql', host: 'b' }),
    ]);
    expect(files.json(SHOP).connections.map((entry) => entry.name)).toEqual(['One', 'Two']);
  });
});

describe('paths', () => {
  it('converts back and forth for paths inside the folder', () => {
    const input = {
      name: 'L',
      driver: 'sqlite' as const,
      file: join(ROOT, 'a', 'b.db'),
    };
    const relative = toRelative(input, ROOT);
    expect(relative.file).toBe('a/b.db');
    expect(toAbsolute(relative, ROOT).file).toBe(join(ROOT, 'a', 'b.db'));
  });

  it('keeps paths outside the folder absolute', () => {
    const outside = join('/', 'data', 'x.db');
    expect(toRelative({ name: 'L', driver: 'sqlite', file: outside }, ROOT).file).toBe(outside);
    expect(toRelative({ name: 'L', driver: 'sqlite', file: ROOT }, ROOT).file).toBe(ROOT);
  });
});
