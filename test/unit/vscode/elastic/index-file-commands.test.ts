import { describe, expect, it, vi } from 'vitest';
import type { IndexFileFormat } from '../../../../src/services/elasticsearch/index-files';
import type { ImportReport } from '../../../../src/services/mongodb/collection-files';
import type { ConnectionConfig } from '../../../../src/shared/connection';
import {
  type ImportOptions,
  type IndexFileSink,
  type IndexFileUi,
  indexFileCommandHandlers,
} from '../../../../src/vscode/elastic/index-file-commands';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';
import { MemoryElastic } from '../../../helpers/memory-elastic';

const indexNode: TreeNode = {
  kind: 'elasticIndex',
  connectionId: 'e1',
  index: { name: 'shop', status: 'open', hidden: false },
};
const connectionNode: TreeNode = { kind: 'connection', connectionId: 'e1' };

async function* chunks(text: string): AsyncGenerator<{ text: string }> {
  yield await Promise.resolve({ text });
}

interface Setup {
  config?: Partial<ConnectionConfig>;
  format?: IndexFileFormat | undefined;
  save?: string | undefined;
  open?: string | undefined;
  options?: ImportOptions | undefined;
  name?: string | undefined;
  confirm?: boolean;
  content?: string;
  cancelAt?: number;
}

function setup(options: Setup = {}) {
  const node = new MemoryElastic({
    documents: [
      { id: 'a', source: '{"name":"Ann"}' },
      { id: 'b', source: '{"name":"Bob"}' },
    ],
  });
  const config: ConnectionConfig = {
    id: 'e1',
    name: 'Search',
    driver: 'elasticsearch',
    host: 'h',
    ...options.config,
  };
  const written: string[] = [];
  const sink: IndexFileSink & { closed: boolean; discarded: boolean } = {
    closed: false,
    discarded: false,
    write: (piece) => {
      written.push(piece);
      return Promise.resolve();
    },
    close: () => {
      sink.closed = true;
      return Promise.resolve();
    },
    discard: () => {
      sink.discarded = true;
      return Promise.resolve();
    },
  };
  const exported: { documents: number; cancelled: boolean }[] = [];
  const imported: [ImportReport, string][] = [];
  const titles: string[] = [];
  const asked: { suggested: string; problem: string | undefined }[] = [];
  const confirms: string[] = [];
  const optionKeys = 'options' in options;
  const ui: IndexFileUi = {
    pickFormat: () => Promise.resolve('format' in options ? options.format : 'documents'),
    pickSaveFile: () => Promise.resolve('save' in options ? options.save : '/tmp/shop.ndjson'),
    pickOpenFile: () => Promise.resolve('open' in options ? options.open : '/tmp/in.ndjson'),
    askImportOptions: () =>
      Promise.resolve(optionKeys ? options.options : { mode: 'skip', ids: 'keep', op: 'index' }),
    askIndexName: (suggested, check) => {
      asked.push({ suggested, problem: check('Bad Name') });
      return Promise.resolve('name' in options ? options.name : 'fresh');
    },
    confirm: (message) => {
      confirms.push(message);
      return Promise.resolve(options.confirm ?? true);
    },
    withProgress: async (title, task) => {
      titles.push(title);
      const signal = {
        get aborted() {
          return options.cancelAt !== undefined && texts.length >= options.cancelAt;
        },
      };
      const texts: string[] = [];
      return await task(signal, (text) => texts.push(text));
    },
    showExported: (result) => exported.push(result),
    showImported: (report, index) => imported.push([report, index]),
  };
  const refreshed: unknown[] = [];
  const handlers = indexFileCommandHandlers({
    manager: { acquireElastic: () => Promise.resolve(node.session) },
    store: { get: (id) => (id === 'e1' ? config : undefined) },
    tree: { refresh: (target) => refreshed.push(target) },
    ui,
    texts: {
      readOnly: 'Read-only',
      noElastic: 'No Elasticsearch',
      exportTitle: (index) => `Exporting ${index}`,
      importTitle: (index) => `Importing into ${index}`,
      importNewTitle: 'Import as New Index',
      documentsDone: (count) => `${count} documents`,
      productionQuestion: (connection, index) => `PRODUCTION ${connection}: ${index}`,
      importAction: 'Import',
    },
    openSink: () => Promise.resolve(sink),
    readChunks: () => chunks(options.content ?? '{"_id":"x","_source":{"n":1}}\n'),
    fileNameFor: (text) => text.replaceAll(' ', '_'),
  });
  return { node, handlers, sink, written, exported, imported, titles, asked, confirms, refreshed };
}

describe('Export Index', () => {
  it('writes the index to the chosen file and closes it', async () => {
    const run = setup();
    await run.handlers.exportIndex(indexNode);
    expect(run.written.join('')).toBe(
      '{"_id":"a","_source":{"name":"Ann"}}\n{"_id":"b","_source":{"name":"Bob"}}\n',
    );
    expect(run.sink.closed).toBe(true);
    expect(run.sink.discarded).toBe(false);
    expect(run.exported).toEqual([{ documents: 2, cancelled: false }]);
    expect(run.titles).toEqual(['Exporting shop']);
  });

  it('does nothing for a node that is not an index, or when the user backs out', async () => {
    for (const options of [{ format: undefined }, { save: undefined }]) {
      const run = setup(options);
      await run.handlers.exportIndex(indexNode);
      expect(run.exported).toEqual([]);
      expect(run.titles).toEqual([]);
    }
    const run = setup();
    await run.handlers.exportIndex(connectionNode);
    await run.handlers.exportIndex(undefined);
    expect(run.titles).toEqual([]);
  });

  it('is allowed on a read-only connection: it only reads', async () => {
    const run = setup({ config: { readOnly: true, production: true } });
    await run.handlers.exportIndex(indexNode);
    expect(run.exported).toHaveLength(1);
    expect(run.confirms).toEqual([]);
  });

  it('discards the file when cancelled, so no half of it stays', async () => {
    const run = setup({ cancelAt: 0 });
    await run.handlers.exportIndex(indexNode);
    expect(run.sink.discarded).toBe(true);
    expect(run.sink.closed).toBe(false);
    expect(run.exported).toEqual([{ documents: 2, cancelled: true }]);
  });

  it('discards the file when the server fails', async () => {
    const run = setup();
    run.node.session.request = () => Promise.reject(new Error('down'));
    await expect(run.handlers.exportIndex(indexNode)).rejects.toThrow('down');
    expect(run.sink.discarded).toBe(true);
    expect(run.exported).toEqual([]);
  });
});

describe('Import Documents', () => {
  it('sends the file into the index and refreshes the tree', async () => {
    const run = setup();
    await run.handlers.importIndex(indexNode);
    expect(run.imported).toHaveLength(1);
    expect(run.imported[0]?.[0]).toMatchObject({ inserted: 1, refused: 0 });
    expect(run.imported[0]?.[1]).toBe('shop');
    expect(run.node.stored.some((document) => document.id === 'x')).toBe(true);
    expect(run.refreshed).toEqual([{ kind: 'connection', connectionId: 'e1' }]);
    expect(run.titles).toEqual(['Importing into shop']);
  });

  it('refuses a read-only connection before it asks anything', async () => {
    const run = setup({ config: { readOnly: true } });
    await expect(run.handlers.importIndex(indexNode)).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(run.titles).toEqual([]);
  });

  it('asks once on a production connection, and a no sends nothing', async () => {
    const yes = setup({ config: { production: true, name: 'Live' } });
    await yes.handlers.importIndex(indexNode);
    expect(yes.confirms).toEqual(['PRODUCTION Live: shop']);
    expect(yes.imported).toHaveLength(1);
    const no = setup({ config: { production: true }, confirm: false });
    await no.handlers.importIndex(indexNode);
    expect(no.imported).toEqual([]);
    expect(no.node.bulks).toEqual([]);
  });

  it('does nothing when the user backs out of the file or the options', async () => {
    for (const options of [{ open: undefined }, { options: undefined }]) {
      const run = setup(options);
      await run.handlers.importIndex(indexNode);
      expect(run.imported).toEqual([]);
      expect(run.node.bulks).toEqual([]);
    }
  });

  it('does nothing for a node that is not an index', async () => {
    const run = setup();
    await run.handlers.importIndex(connectionNode);
    await run.handlers.importIndex(undefined);
    expect(run.imported).toEqual([]);
  });

  it('passes the options the user chose on to the load', async () => {
    const run = setup({
      options: { mode: 'stop', ids: 'generate', op: 'create' },
      content: '{"_id":"a","_source":{"n":1}}\n',
    });
    await run.handlers.importIndex(indexNode);
    expect(run.node.bulks[0]).toBe('{"create":{}}\n{"n":1}\n');
  });
});

describe('Import as New Index', () => {
  const header =
    '{"datanest":"elasticsearch-index","version":1,"index":"orders","settings":{"index":{"number_of_shards":"2"}},"mappings":{"properties":{"n":{"type":"long"}}}}\n';

  it('makes the index like the one in the file, then fills it', async () => {
    const run = setup({ content: `${header}{"_id":"a","_source":{"n":1}}\n` });
    await run.handlers.importNewIndex(connectionNode);
    expect(run.asked[0]?.suggested).toBe('orders');
    const create = run.node.session.requests.find((line) => line.startsWith('PUT /fresh'));
    expect(create).toBe(
      'PUT /fresh {"settings":{"index":{"number_of_shards":"2"}},"mappings":{"properties":{"n":{"type":"long"}}}}',
    );
    expect(run.imported[0]?.[1]).toBe('fresh');
    expect(run.imported[0]?.[0].inserted).toBe(1);
  });

  it('makes a plain index for a file without a header, named after the file', async () => {
    const run = setup({ open: '/home/me/My Orders.ndjson' });
    await run.handlers.importNewIndex(connectionNode);
    expect(run.asked[0]?.suggested).toBe('my_orders');
    expect(run.node.session.requests.find((line) => line.startsWith('PUT /fresh'))).toBe(
      'PUT /fresh',
    );
  });

  it('checks the name as it is typed', async () => {
    const run = setup();
    await run.handlers.importNewIndex(connectionNode);
    expect(run.asked[0]?.problem).toMatch(/lowercase/);
  });

  it('trims the name', async () => {
    const run = setup({ name: '  fresh  ' });
    await run.handlers.importNewIndex(connectionNode);
    expect(run.imported[0]?.[1]).toBe('fresh');
  });

  it('works from the id of the connection too, as the palette gives it', async () => {
    const run = setup();
    await run.handlers.importNewIndex('e1');
    expect(run.imported).toHaveLength(1);
  });

  it('refuses a read-only connection, and a connection that is not Elasticsearch', async () => {
    const readOnly = setup({ config: { readOnly: true } });
    await expect(readOnly.handlers.importNewIndex(connectionNode)).rejects.toMatchObject({
      code: 'permission-denied',
    });
    const other = setup({ config: { driver: 'redis' } });
    await expect(other.handlers.importNewIndex(connectionNode)).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(other.handlers.importNewIndex(undefined)).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('creates nothing when the user backs out at any question', async () => {
    for (const options of [{ open: undefined }, { name: undefined }, { options: undefined }]) {
      const run = setup(options);
      await run.handlers.importNewIndex(connectionNode);
      expect(run.node.session.requests.filter((line) => line.startsWith('PUT'))).toEqual([]);
      expect(run.imported).toEqual([]);
    }
  });

  it('asks before making an index on a production connection', async () => {
    const run = setup({ config: { production: true }, confirm: false });
    await run.handlers.importNewIndex(connectionNode);
    expect(run.confirms).toHaveLength(1);
    expect(run.node.session.requests.filter((line) => line.startsWith('PUT'))).toEqual([]);
  });

  it('stops with the server own message when the index exists', async () => {
    const run = setup();
    const spy = vi.fn();
    run.node.session.request = (request) => {
      spy(request.method);
      return Promise.resolve({
        status: 400,
        contentType: 'application/json',
        body: '{"error":{"type":"resource_already_exists_exception","reason":"index [fresh] already exists"},"status":400}',
      });
    };
    await expect(run.handlers.importNewIndex(connectionNode)).rejects.toThrow(/already exists/);
    expect(run.imported).toEqual([]);
  });
});
