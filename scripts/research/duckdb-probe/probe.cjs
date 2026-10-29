// V6.6 research probe: can DuckDB-WASM's Node build serve as a DuckDB driver without native
// code? Usage: node probe.cjs <folder with node_modules/@duckdb/duckdb-wasm> <scratch folder>.
// It reports start-up time, an in-memory query, and whether a real .duckdb file can be
// written, closed and read again, by plain path and by a file registered with NODE_FS.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const [root, scratch] = process.argv.slice(2);
if (root === undefined || scratch === undefined) {
  throw new Error('usage: node probe.cjs <package folder> <scratch folder>');
}
const dist = path.join(root, 'node_modules', '@duckdb', 'duckdb-wasm', 'dist');
const duckdb = require(path.join(dist, 'duckdb-node-blocking.cjs'));
const BUNDLES = {
  mvp: {
    mainModule: path.join(dist, 'duckdb-mvp.wasm'),
    mainWorker: path.join(dist, 'duckdb-node-mvp.worker.cjs'),
  },
  eh: {
    mainModule: path.join(dist, 'duckdb-eh.wasm'),
    mainWorker: path.join(dist, 'duckdb-node-eh.worker.cjs'),
  },
};

/** @param {...unknown} parts */
function report(...parts) {
  process.stdout.write(`${parts.map(String).join(' ')}\n`);
}

async function instance() {
  const db = await duckdb.createDuckDB(BUNDLES, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
  await db.instantiate();
  return db;
}

/** @param {any} db @param {string} sql */
function count(db, sql) {
  const connection = db.connect();
  try {
    return connection.query(sql).toArray()[0].toJSON().n;
  } finally {
    connection.close();
  }
}

/** @param {string} label @param {() => Promise<unknown>} run */
async function step(label, run) {
  try {
    report(label, 'ok', JSON.stringify(await run()));
  } catch (error) {
    report(label, 'failed', (error instanceof Error ? error.message : String(error)).slice(0, 300));
  }
}

async function main() {
  fs.mkdirSync(scratch, { recursive: true });
  const started = Date.now();
  const memory = await instance();
  report('version', memory.getVersion(), 'start ms', Date.now() - started);
  await step('in memory', async () =>
    count(memory, 'SELECT count(*)::INT AS n FROM range(100000)'),
  );

  const plain = path.join(scratch, 'plain.duckdb');
  fs.rmSync(plain, { force: true });
  await step('plain path: write', async () => {
    const db = await instance();
    db.open({ path: plain, accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
    const connection = db.connect();
    connection.query('CREATE TABLE t AS SELECT range AS n FROM range(5)');
    connection.query('CHECKPOINT');
    connection.close();
    return { rows: count(db, 'SELECT count(*)::INT AS n FROM t'), bytes: fs.statSync(plain).size };
  });
  await step('plain path: read again', async () => {
    const db = await instance();
    db.open({ path: plain, accessMode: duckdb.DuckDBAccessMode.READ_ONLY });
    return count(db, 'SELECT count(*)::INT AS n FROM t');
  });

  const registered = path.join(scratch, 'registered.duckdb');
  fs.rmSync(registered, { force: true });
  await step('NODE_FS: write a new file', async () => {
    const db = await instance();
    db.registerFileURL('r.duckdb', registered, duckdb.DuckDBDataProtocol.NODE_FS, false);
    db.open({ path: 'r.duckdb', accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
    return count(db, 'SELECT 1 AS n');
  });
  await step('NODE_FS: read the file the plain path wrote', async () => {
    const db = await instance();
    db.registerFileURL('p.duckdb', plain, duckdb.DuckDBDataProtocol.NODE_FS, false);
    db.open({ path: 'p.duckdb', accessMode: duckdb.DuckDBAccessMode.READ_ONLY });
    return count(db, 'SELECT count(*)::INT AS n FROM t');
  });
  const wasm = fs.statSync(BUNDLES.eh.mainModule).size;
  report('wasm bytes (eh)', wasm);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
