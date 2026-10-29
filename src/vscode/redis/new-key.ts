// The questions for a new Redis key (V7.3): its name, its type and what it starts with,
// since Redis keeps no empty hash, list, set or stream.

import * as vscode from 'vscode';
import type { NewKeyContent } from '../../services/redis/key-edits';
import { isScore } from '../../services/redis/key-edits';
import { EDITABLE_TYPES, type EditableType } from '../../shared/protocols/redis-key';

async function ask(
  title: string,
  prompt: string,
  value = '',
  check?: (text: string) => string | undefined,
): Promise<string | undefined> {
  return await vscode.window.showInputBox({
    title,
    prompt,
    value,
    ...(check === undefined ? {} : { validateInput: check }),
  });
}

export async function askNewKey(
  prefix: string,
): Promise<{ readonly name: string; readonly content: NewKeyContent } | undefined> {
  const title = vscode.l10n.t('New Redis Key');
  const name = await ask(title, vscode.l10n.t('The name of the key'), prefix, (text) =>
    text === '' ? vscode.l10n.t('A key needs a name') : undefined,
  );
  if (name === undefined) {
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    EDITABLE_TYPES.map((type) => ({ label: type, type })),
    { title, placeHolder: vscode.l10n.t('The type of "{0}"', name) },
  );
  if (picked === undefined) {
    return undefined;
  }
  const content = await askContent(title, picked.type);
  return content === undefined ? undefined : { name, content };
}

async function askContent(title: string, type: EditableType): Promise<NewKeyContent | undefined> {
  const value = (prompt: string): Promise<string | undefined> => ask(title, prompt);
  switch (type) {
    case 'string': {
      const text = await value(vscode.l10n.t('The value'));
      return text === undefined ? undefined : { type, value: { text } };
    }
    case 'list':
    case 'set': {
      const text = await value(vscode.l10n.t('The first element; Redis keeps no empty {0}', type));
      return text === undefined ? undefined : { type, value: { text } };
    }
    case 'zset': {
      const member = await value(vscode.l10n.t('The first member; Redis keeps no empty {0}', type));
      if (member === undefined) {
        return undefined;
      }
      const score = await ask(title, vscode.l10n.t('Its score'), '0', (text) =>
        isScore(text) ? undefined : vscode.l10n.t('Write a number, inf or -inf'),
      );
      return score === undefined ? undefined : { type, value: { text: member }, score };
    }
    case 'hash':
    case 'stream': {
      const field = await value(vscode.l10n.t('The first field; Redis keeps no empty {0}', type));
      if (field === undefined) {
        return undefined;
      }
      const text = await value(vscode.l10n.t('The value of "{0}"', field));
      return text === undefined ? undefined : { type, field: { text: field }, value: { text } };
    }
  }
}
