// V0.12 research probe. VS Code loads this file as `extensionTestsPath`, so it runs
// inside the real extension host of each editor and reports what SQLite engines work there.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const vscode = require('vscode');

const ROWS = 100_000;

/** @param {() => unknown} fn */
function attempt(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** @param {() => void} fn */
function timeMs(fn) {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

/** @param {any} db @param {(sql: string) => unknown} get */
function features(db, get) {
  return {
    json: attempt(() => get(`SELECT json_extract('{"a":{"b":42}}', '$.a.b') AS v`)),
    fts5: attempt(() => {
      db.exec('CREATE VIRTUAL TABLE fts_probe USING fts5(body)');
      return true;
    }),
    returning: attempt(() => {
      db.exec('CREATE TABLE ret_probe (id INTEGER PRIMARY KEY, v TEXT)');
      return get(`INSERT INTO ret_probe (v) VALUES ('x') RETURNING id AS v`);
    }),
    windowFunctions: attempt(() => get('SELECT row_number() OVER () AS v')),
    mathFunctions: attempt(() => get('SELECT sqrt(16) AS v')),
    strictTables: attempt(() => {
      db.exec('CREATE TABLE strict_probe (id INTEGER) STRICT');
      return true;
    }),
  };
}

function probeNodeSqlite(dir) {
  const warnings = [];
  const onWarning = (w) => warnings.push(`${w.name}: ${w.message}`);
  process.on('warning', onWarning);
  const loaded = attempt(() => require('node:sqlite'));
  if (!loaded.ok) {
    process.off('warning', onWarning);
    return { available: false, error: loaded.error };
  }
  const sqlite = /** @type {any} */ (loaded.value);
  const file = path.join(dir, 'node-sqlite.db');
  const db = new sqlite.DatabaseSync(file);
  const get = (sql) => db.prepare(sql).get().v;
  const report = {
    available: true,
    sqliteVersion: get('SELECT sqlite_version() AS v'),
    api: {
      iterate: typeof db.prepare('SELECT 1').iterate === 'function',
      setReadBigInts: typeof db.prepare('SELECT 1').setReadBigInts === 'function',
      columns: typeof db.prepare('SELECT 1').columns === 'function',
      backup: typeof sqlite.backup === 'function',
      userFunctions: typeof db.function === 'function',
      isTransaction: 'isTransaction' in db,
    },
    features: features(db, get),
    bigint: attempt(() => {
      const stmt = db.prepare('SELECT 9223372036854775807 AS v');
      stmt.setReadBigInts(true);
      return String(stmt.get().v);
    }),
  };
  db.exec('CREATE TABLE perf (id INTEGER PRIMARY KEY, label TEXT, n INTEGER)');
  const insert = db.prepare('INSERT INTO perf (label, n) VALUES (?, ?)');
  report.insertMs = timeMs(() => {
    db.exec('BEGIN');
    for (let i = 0; i < ROWS; i++) {
      insert.run(`row-${i}`, i);
    }
    db.exec('COMMIT');
  });
  report.selectAllMs = timeMs(() => {
    db.prepare('SELECT * FROM perf').all();
  });
  db.close();
  report.persistsToFile = attempt(() => {
    const again = new sqlite.DatabaseSync(file);
    const count = again.prepare('SELECT COUNT(*) AS v FROM perf').get().v;
    again.close();
    return count;
  });
  report.fileBytes = fs.statSync(file).size;
  process.off('warning', onWarning);
  report.warnings = warnings;
  return report;
}

async function probeSqlJs(dir) {
  const root = path.resolve(__dirname, '../../..');
  const loaded = attempt(() => require(path.join(root, 'node_modules/sql.js/dist/sql-wasm.js')));
  if (!loaded.ok) {
    return { available: false, error: loaded.error };
  }
  const initSqlJs = /** @type {any} */ (loaded.value);
  const SQL = await initSqlJs({
    locateFile: (name) => path.join(root, 'node_modules/sql.js/dist', name),
  });
  const db = new SQL.Database();
  const get = (sql) => db.exec(sql)[0]?.values[0]?.[0];
  const report = {
    available: true,
    sqliteVersion: get('SELECT sqlite_version()'),
    features: features({ exec: (sql) => db.run(sql) }, get),
  };
  db.run('CREATE TABLE perf (id INTEGER PRIMARY KEY, label TEXT, n INTEGER)');
  const insert = db.prepare('INSERT INTO perf (label, n) VALUES (?, ?)');
  report.insertMs = timeMs(() => {
    db.run('BEGIN');
    for (let i = 0; i < ROWS; i++) {
      insert.run([`row-${i}`, i]);
    }
    db.run('COMMIT');
  });
  insert.free();
  report.selectAllMs = timeMs(() => {
    db.exec('SELECT * FROM perf');
  });
  // sql.js keeps the whole database in memory; saving means exporting all bytes.
  const file = path.join(dir, 'sqljs.db');
  report.exportMs = timeMs(() => {
    fs.writeFileSync(file, db.export());
  });
  report.fileBytes = fs.statSync(file).size;
  report.heapUsedMb = Math.round(process.memoryUsage().heapUsed / 1e6);
  db.close();
  return report;
}

function probeWorker() {
  const code = `
    const { parentPort } = require('node:worker_threads');
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(':memory:');
      parentPort.postMessage({ ok: true, value: db.prepare('SELECT sqlite_version() AS v').get().v });
    } catch (error) {
      parentPort.postMessage({ ok: false, error: String(error && error.message || error) });
    }`;
  return new Promise((resolve) => {
    const worker = new Worker(code, { eval: true });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve({ ok: false, error: 'timeout' });
    }, 10_000);
    worker.once('message', (message) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(message);
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
  });
}

async function run() {
  const out = process.env.DATANEST_PROBE_OUT;
  if (!out) {
    throw new Error('DATANEST_PROBE_OUT is not set');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'datanest-probe-'));
  try {
    const report = {
      app: vscode.env.appName,
      vscodeVersion: vscode.version,
      node: process.versions.node,
      electron: process.versions.electron,
      platform: `${process.platform}-${process.arch}`,
      nodeSqlite: attempt(() => probeNodeSqlite(dir)),
      nodeSqliteInWorker: await probeWorker(),
      sqljs: await probeSqlJs(dir).catch((/** @type {unknown} */ error) => ({
        available: false,
        error: String(error),
      })),
    };
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { run };
