// Reads one statement of a MongoDB query document (V7.7): `use shop`, `show collections`,
// `db.orders.find({ … }).sort({ … }).limit(5)`, `db.getCollection("a b").aggregate([…])`,
// `db.getSiblingDB("logs").events.countDocuments({})`, `db.runCommand({ … })`. The
// arguments are data (shell-reader.ts); the statement is never evaluated.

import { ShellReader, ShellSyntaxError } from './shell-reader';
import type { MongoValue } from './value';

export interface ShellCall {
  readonly method: string;
  readonly args: readonly MongoValue[];
}

export type ShellStatement =
  | { readonly kind: 'use'; readonly database: string }
  | { readonly kind: 'show'; readonly what: 'databases' | 'collections' }
  | {
      readonly kind: 'call';
      /** Set by `db.getSiblingDB("…")`; otherwise the editor's database. */
      readonly database?: string;
      /** Absent for a method of the database itself (`db.runCommand`). */
      readonly collection?: string;
      readonly call: ShellCall;
      /** `.sort(…).limit(…)` after the call, in order. */
      readonly chain: readonly ShellCall[];
    };

const SHOW: Readonly<Record<string, 'databases' | 'collections'>> = {
  dbs: 'databases',
  databases: 'databases',
  collections: 'collections',
  tables: 'collections',
};

/** What may follow `use`: a database name up to the end of the statement. */
const DATABASE_NAME = /^[^\s/\\."$*<>:|?;]+$/u;

function args(reader: ShellReader): MongoValue[] {
  const values: MongoValue[] = [];
  reader.expect('(');
  while (!reader.accept(')')) {
    values.push(reader.value());
    if (!reader.accept(',')) {
      reader.expect(')', '"," or ")"');
      break;
    }
  }
  return values;
}

function stringArg(reader: ShellReader, what: string): string {
  reader.expect('(');
  const at = reader.offset;
  const value = reader.value();
  if (value.type !== 'string') {
    reader.fail(`${what} expects a name in quotes`, at);
  }
  reader.expect(')');
  return value.value;
}

/** `.name(` ahead: a method call, not another part of a collection name. */
function callFollows(reader: ShellReader): boolean {
  reader.skipSpace();
  return reader.peek() === '(';
}

export function parseShellStatement(text: string): ShellStatement {
  const reader: ShellReader = new ShellReader(text.trim().replace(/;$/, ''));
  if (reader.atEnd()) {
    reader.fail('There is no statement here');
  }
  const head = reader.identifier();
  if (head === 'use') {
    const name = reader.text.slice(reader.offset).trim();
    if (!DATABASE_NAME.test(name)) {
      reader.fail('use expects the name of a database');
    }
    return { kind: 'use', database: name };
  }
  if (head === 'show') {
    const what = reader.identifier();
    const shown = what === undefined ? undefined : SHOW[what];
    if (shown === undefined || !reader.atEnd()) {
      reader.fail('DataNest shows "dbs" and "collections"');
    }
    return { kind: 'show', what: shown };
  }
  if (head !== 'db') {
    reader.fail(
      head === undefined
        ? 'A statement starts with db, use or show'
        : `"${head}" is not something DataNest runs: a statement starts with db, use or show`,
      0,
    );
  }
  let database: string | undefined;
  let collection: string | undefined;
  const names: string[] = [];
  let call: ShellCall | undefined;
  while (call === undefined) {
    reader.skipSpace();
    if (reader.accept('[')) {
      // db["my collection"]
      const at = reader.offset;
      const value = reader.value();
      if (value.type !== 'string') {
        reader.fail('A collection name in brackets goes in quotes', at);
      }
      reader.expect(']');
      collection = [...names, value.value].join('.');
      names.length = 0;
      continue;
    }
    reader.expect('.', '"." and a method');
    const name = reader.identifier();
    if (name === undefined) {
      reader.fail(`Expected a name after "."${reader.near()}`);
    }
    if (!callFollows(reader)) {
      names.push(name);
      continue;
    }
    if (collection === undefined && names.length === 0 && name === 'getSiblingDB') {
      database = stringArg(reader, 'getSiblingDB');
      continue;
    }
    if (collection === undefined && names.length === 0 && name === 'getCollection') {
      collection = stringArg(reader, 'getCollection');
      continue;
    }
    if (names.length > 0) {
      collection = [...(collection === undefined ? [] : [collection]), ...names].join('.');
      names.length = 0;
    }
    call = { method: name, args: args(reader) };
  }
  const chain: ShellCall[] = [];
  while (!reader.atEnd()) {
    reader.expect('.', 'the end of the statement or "." and a method');
    const name = reader.identifier();
    if (name === undefined) {
      reader.fail(`Expected a method after "."${reader.near()}`);
    }
    if (!callFollows(reader)) {
      reader.fail(`Expected "(" after ${name}`);
    }
    chain.push({ method: name, args: args(reader) });
  }
  return {
    kind: 'call',
    ...(database === undefined ? {} : { database }),
    ...(collection === undefined ? {} : { collection }),
    call,
    chain,
  };
}

export { ShellSyntaxError };
