// The questions of the MongoDB tree commands (V7.5): a new collection's name and kind, a
// new index's keys and options in the shell's syntax, checked as they are typed.

import * as vscode from 'vscode';
import { parseDocument, ShellSyntaxError } from '../../core/mongo/shell-parse';
import type { MongoDocument } from '../../core/mongo/value';
import {
  collectionNameProblem,
  indexKeyProblem,
  type NewCollection,
} from '../../services/mongodb/schema-edits';
import type { TextQuestion } from './mongo-tree-commands';

export async function askText(question: TextQuestion): Promise<string | undefined> {
  return await vscode.window.showInputBox({
    title: question.title,
    prompt: question.prompt,
    ignoreFocusOut: true,
    ...(question.value === undefined ? {} : { value: question.value }),
    ...(question.placeHolder === undefined ? {} : { placeHolder: question.placeHolder }),
    ...(question.check === undefined ? {} : { validateInput: question.check }),
  });
}

/** What is wrong with a document typed in the shell's syntax, or undefined. */
function documentProblem(
  text: string,
  extra?: (document: MongoDocument) => string | undefined,
): string | undefined {
  try {
    const document = parseDocument(text, 'error');
    return extra?.(document);
  } catch (error) {
    return error instanceof ShellSyntaxError ? error.message : String(error);
  }
}

function positiveNumber(text: string): string | undefined {
  return /^\d+$/.test(text.trim()) && Number(text) > 0
    ? undefined
    : vscode.l10n.t('A whole number above 0');
}

export async function askNewCollection(
  database: string,
): Promise<{ readonly name: string; readonly options: NewCollection } | undefined> {
  const title = vscode.l10n.t('New Collection in {0}', database);
  const name = await askText({
    title,
    prompt: vscode.l10n.t('The name of the collection'),
    check: collectionNameProblem,
  });
  if (name === undefined) {
    return undefined;
  }
  const kinds = [
    { label: vscode.l10n.t('Collection'), collectionKind: 'collection' as const },
    {
      label: vscode.l10n.t('Capped collection'),
      description: vscode.l10n.t('a fixed size; the oldest documents make room for new ones'),
      collectionKind: 'capped' as const,
    },
    {
      label: vscode.l10n.t('Time series collection'),
      description: vscode.l10n.t('measurements over time, stored compactly'),
      collectionKind: 'timeseries' as const,
    },
  ];
  const picked = await vscode.window.showQuickPick(kinds, {
    title,
    placeHolder: vscode.l10n.t('What kind of collection is "{0}"', name),
  });
  switch (picked?.collectionKind) {
    case undefined:
      return undefined;
    case 'collection':
      return { name, options: { kind: 'collection' } };
    case 'capped': {
      const megabytes = await askText({
        title,
        prompt: vscode.l10n.t('The size in megabytes'),
        value: '16',
        check: positiveNumber,
      });
      if (megabytes === undefined) {
        return undefined;
      }
      const max = await askText({
        title,
        prompt: vscode.l10n.t('The most documents it keeps; empty for no limit but the size'),
        check: (text) => (text.trim() === '' ? undefined : positiveNumber(text)),
      });
      if (max === undefined) {
        return undefined;
      }
      return {
        name,
        options: {
          kind: 'capped',
          sizeBytes: Number(megabytes) * 1024 * 1024,
          ...(max.trim() === '' ? {} : { maxDocuments: Number(max) }),
        },
      };
    }
    case 'timeseries': {
      const timeField = await askText({
        title,
        prompt: vscode.l10n.t('The field that holds the time of each measurement'),
        value: 'timestamp',
        check: (text) => (text.trim() === '' ? vscode.l10n.t('A field name is needed') : undefined),
      });
      if (timeField === undefined) {
        return undefined;
      }
      const metaField = await askText({
        title,
        prompt: vscode.l10n.t('The field that names the source (a sensor, a host); empty for none'),
      });
      if (metaField === undefined) {
        return undefined;
      }
      return {
        name,
        options: {
          kind: 'timeseries',
          timeField: timeField.trim(),
          ...(metaField.trim() === '' ? {} : { metaField: metaField.trim() }),
        },
      };
    }
  }
}

export async function askIndex(
  collection: string,
): Promise<{ readonly keys: MongoDocument; readonly options: MongoDocument } | undefined> {
  const title = vscode.l10n.t('New Index on {0}', collection);
  const keysText = await askText({
    title,
    prompt: vscode.l10n.t('The keys: 1 ascending, -1 descending, or "text", "2dsphere", "hashed"'),
    placeHolder: '{ email: 1 }',
    check: (text) => documentProblem(text, indexKeyProblem),
  });
  if (keysText === undefined) {
    return undefined;
  }
  const optionsText = await askText({
    title,
    prompt: vscode.l10n.t(
      'Options, empty for none: unique, sparse, expireAfterSeconds, partialFilterExpression, name',
    ),
    placeHolder: '{ unique: true }',
    check: (text) => (text.trim() === '' ? undefined : documentProblem(text)),
  });
  if (optionsText === undefined) {
    return undefined;
  }
  return { keys: parseDocument(keysText, 'error'), options: parseDocument(optionsText) };
}
