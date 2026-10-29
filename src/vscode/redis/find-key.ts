// "Find Redis Key" (V7.2): a Quick Pick that runs SCAN with the typed text as the user
// types. SCAN walks the keys a portion at a time, so even millions of keys never block
// the server; a search stops at a number of matches or after a few seconds.

import * as vscode from 'vscode';
import { errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import type { RedisKeyBrowser } from '../../services/redis/key-browser';
import { findKeys } from '../../services/redis/key-scan';
import type { LoadedKey } from '../../services/redis/key-tree';
import type { RedisPlace } from './redis-key-commands';

/** Matches one search shows; a narrower text finds the rest. */
export const FIND_LIMIT = 200;
/** How long one search may walk the keys. */
export const FIND_BUDGET_MS = 3000;
/** Typing pauses this long before a search starts. */
const DEBOUNCE_MS = 250;

interface KeyItem extends vscode.QuickPickItem {
  readonly entry?: LoadedKey;
}

export async function pickRedisKey(
  browser: Pick<RedisKeyBrowser, 'session'>,
  place: RedisPlace,
  initial: string,
  logger: Logger,
): Promise<LoadedKey | undefined> {
  const picker = vscode.window.createQuickPick<KeyItem>();
  picker.title = vscode.l10n.t('Find a key in db{0}', place.database);
  picker.placeholder = vscode.l10n.t('Part of the name, or a pattern such as user:*:name');
  picker.matchOnDescription = false;
  picker.value = initial;
  // A newer search makes the answer of an older one stale.
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const search = async (text: string): Promise<void> => {
    const current = ++generation;
    if (text.trim() === '') {
      picker.busy = false;
      picker.items = [];
      return;
    }
    picker.busy = true;
    try {
      const session = await browser.session(place.connectionId, place.database);
      const found = await findKeys(session, text, { limit: FIND_LIMIT, budgetMs: FIND_BUDGET_MS });
      if (current !== generation) {
        return;
      }
      const items: KeyItem[] = found.keys.map((entry) => ({
        label: entry.key.text,
        ...(entry.type === undefined ? {} : { description: entry.type }),
        // The server matched them; the picker must not filter them out again.
        alwaysShow: true,
        entry,
      }));
      if (!found.complete || found.keys.length >= FIND_LIMIT) {
        items.push({
          label: '',
          kind: vscode.QuickPickItemKind.Separator,
        });
        items.push({
          label: vscode.l10n.t('$(info) Not every key was looked at: type more of the name'),
          alwaysShow: true,
        });
      } else if (found.keys.length === 0) {
        items.push({ label: vscode.l10n.t('$(info) No key matches'), alwaysShow: true });
      }
      picker.items = items;
    } catch (error) {
      if (current === generation) {
        logger.warn('Finding a Redis key failed', error);
        picker.items = [{ label: `$(error) ${errorMessage(error)}`, alwaysShow: true }];
      }
    } finally {
      if (current === generation) {
        picker.busy = false;
      }
    }
  };

  return await new Promise<LoadedKey | undefined>((resolve) => {
    let chosen: LoadedKey | undefined;
    picker.onDidChangeValue((text) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void search(text);
      }, DEBOUNCE_MS);
    });
    picker.onDidAccept(() => {
      const entry = picker.selectedItems[0]?.entry;
      if (entry !== undefined) {
        chosen = entry;
        picker.hide();
      }
    });
    picker.onDidHide(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      generation += 1;
      picker.dispose();
      resolve(chosen);
    });
    picker.show();
    if (initial !== '') {
      void search(initial);
    }
  });
}
