// What the Redis key page (V7.3) shows and does, free of `vscode`: it reads the key, its
// pages of items, and runs the changes the page asks for, then reads again — the server
// is the source of truth, and other clients change keys too.

import { DbError } from '../../core/errors';
import type { RedisSession } from '../../drivers/redis-driver';
import * as edits from '../../services/redis/key-edits';
import {
  type ItemCursor,
  type KeyOverview,
  readItems,
  readOverview,
  readString,
} from '../../services/redis/key-values';
import {
  ITEM_PAGE_SIZE,
  type RedisKeyItem,
  type RedisKeyState,
} from '../../shared/protocols/redis-key';
import { type RedisKeyRef, redisKeyBytes, redisKeyRef } from '../../shared/redis-key';
import type { RedisValue } from '../../shared/redis-value';
import { msg } from '../../core/user-message';

export interface RedisKeyModelDeps {
  readonly key: RedisKeyRef;
  readonly database: number;
  readonly connectionName: string;
  readonly readOnly: boolean;
  /** The session of the key's database. */
  readonly session: () => Promise<RedisSession>;
  readonly pageSize?: number;
}

/** A change the page asks for, as the protocol sends it. */
export type RedisKeyEdit =
  | { readonly kind: 'setString'; readonly value: RedisValue }
  | {
      readonly kind: 'setField';
      readonly field: RedisValue;
      readonly value: RedisValue;
      readonly previous?: RedisValue;
    }
  | { readonly kind: 'deleteField'; readonly field: RedisValue }
  | {
      readonly kind: 'setListItem';
      readonly index: number;
      readonly expected: RedisValue;
      readonly value: RedisValue;
    }
  | { readonly kind: 'pushListItem'; readonly end: 'head' | 'tail'; readonly value: RedisValue }
  | { readonly kind: 'removeListItem'; readonly index: number; readonly expected: RedisValue }
  | { readonly kind: 'setMember'; readonly value: RedisValue; readonly previous?: RedisValue }
  | { readonly kind: 'deleteMember'; readonly value: RedisValue }
  | {
      readonly kind: 'setScoredMember';
      readonly value: RedisValue;
      readonly score: string;
      readonly previous?: RedisValue;
    }
  | {
      readonly kind: 'addEntry';
      readonly id: string;
      readonly fields: readonly { field: RedisValue; value: RedisValue }[];
    }
  | { readonly kind: 'deleteEntry'; readonly id: string }
  | { readonly kind: 'setTtl'; readonly seconds: number | null };

/** One identity per item, so a page that SCAN repeats is not shown twice. */
function itemId(item: RedisKeyItem): string {
  const value = (part: RedisValue | undefined): string => part?.hex ?? `t:${part?.text ?? ''}`;
  return (
    item.id ??
    (item.index === undefined ? `${value(item.field)}|${value(item.value)}` : String(item.index))
  );
}

export class RedisKeyModel {
  private key: RedisKeyRef;
  private overview: KeyOverview = { exists: false, type: 'none', ttlMs: null };
  private value: RedisValue | undefined;
  private items: RedisKeyItem[] = [];
  private next: ItemCursor | undefined;
  private pattern: string | undefined;

  constructor(private readonly deps: RedisKeyModelDeps) {
    this.key = deps.key;
  }

  get currentKey(): RedisKeyRef {
    return this.key;
  }

  get type(): string {
    return this.overview.type;
  }

  /** What the page renders. */
  state(): RedisKeyState {
    const { overview } = this;
    return {
      key: this.key,
      database: this.deps.database,
      connectionName: this.deps.connectionName,
      readOnly: this.deps.readOnly,
      exists: overview.exists,
      type: overview.type,
      ttlMs: overview.ttlMs,
      ...(overview.length === undefined ? {} : { length: overview.length }),
      ...(overview.memory === undefined ? {} : { memory: overview.memory }),
      ...(overview.encoding === undefined ? {} : { encoding: overview.encoding }),
      ...(this.value === undefined ? {} : { value: this.value }),
      ...(overview.exists && overview.type !== 'string'
        ? { items: this.items, more: this.next !== undefined }
        : {}),
      ...(this.pattern === undefined ? {} : { filter: this.pattern }),
    };
  }

  /**
   * Reads the key again. With `keep`, as many items are read as were shown, so an
   * edit far down a long list does not send the user back to the first page.
   */
  async refresh(keep = false): Promise<RedisKeyState> {
    const session = await this.deps.session();
    const bytes = redisKeyBytes(this.key);
    const shown = keep ? this.items.length : 0;
    this.overview = await readOverview(session, bytes);
    this.value = undefined;
    this.items = [];
    this.next = undefined;
    if (!this.overview.exists) {
      return this.state();
    }
    if (this.overview.type === 'string') {
      this.value = await readString(session, bytes);
      return this.state();
    }
    do {
      await this.readPage(session);
    } while (this.hasMore() && this.items.length < shown);
    return this.state();
  }

  async loadMore(): Promise<RedisKeyState> {
    if (this.next !== undefined) {
      await this.readPage(await this.deps.session());
    }
    return this.state();
  }

  /** Lists only items that match a glob (hash, set, zset); empty or `*` lists all. */
  async filter(pattern: string): Promise<RedisKeyState> {
    const trimmed = pattern.trim();
    this.pattern = trimmed === '' || trimmed === '*' ? undefined : trimmed;
    return await this.refresh();
  }

  /** Runs one change, then reads the key again keeping the items shown. */
  async apply(edit: RedisKeyEdit): Promise<RedisKeyState> {
    this.refuseIfReadOnly();
    const session = await this.deps.session();
    const key = redisKeyBytes(this.key);
    switch (edit.kind) {
      case 'setString':
        await edits.setString(session, key, edit.value);
        break;
      case 'setField':
        await edits.setField(session, key, edit.field, edit.value, edit.previous);
        break;
      case 'deleteField':
        await edits.deleteField(session, key, edit.field);
        break;
      case 'setListItem':
        await edits.setListItem(session, key, edit.index, edit.expected, edit.value);
        break;
      case 'pushListItem':
        await edits.pushListItem(session, key, edit.end, edit.value);
        break;
      case 'removeListItem':
        await edits.removeListItem(session, key, edit.index, edit.expected);
        break;
      case 'setMember':
        await edits.setMember(session, key, edit.value, edit.previous);
        break;
      case 'deleteMember':
        await edits.deleteMember(session, key, this.overview.type, edit.value);
        break;
      case 'setScoredMember':
        await edits.setScoredMember(session, key, edit.value, edit.score, edit.previous);
        break;
      case 'addEntry':
        await edits.addEntry(session, key, edit.id, edit.fields);
        break;
      case 'deleteEntry':
        await edits.deleteEntry(session, key, edit.id);
        break;
      case 'setTtl':
        await edits.setTtl(session, key, edit.seconds);
        break;
    }
    return await this.refresh(true);
  }

  /**
   * RENAMENX to `name`; false when the name is taken and `replace` is not set. On
   * success the page follows the key to its new name.
   */
  async rename(name: string, replace: boolean): Promise<boolean> {
    this.refuseIfReadOnly();
    const target = new TextEncoder().encode(name);
    const renamed = await edits.renameKey(
      await this.deps.session(),
      redisKeyBytes(this.key),
      target,
      replace,
    );
    if (renamed) {
      this.key = redisKeyRef(target);
      await this.refresh(true);
    }
    return renamed;
  }

  async deleteKey(): Promise<void> {
    this.refuseIfReadOnly();
    await edits.deleteKeys(await this.deps.session(), [redisKeyBytes(this.key)]);
    await this.refresh();
  }

  /** Read through a method: the compiler cannot see `readPage` move the cursor. */
  private hasMore(): boolean {
    return this.next !== undefined;
  }

  private refuseIfReadOnly(): void {
    if (this.deps.readOnly) {
      throw new DbError(
        'permission-denied',
        msg('The connection is read-only: nothing may change'),
      );
    }
  }

  private async readPage(session: RedisSession): Promise<void> {
    const page = await readItems(session, redisKeyBytes(this.key), this.overview.type, this.next, {
      pageSize: this.deps.pageSize ?? ITEM_PAGE_SIZE,
      ...(this.pattern === undefined ? {} : { match: this.pattern }),
    });
    const seen = new Set(this.items.map(itemId));
    this.items.push(...page.items.filter((item) => !seen.has(itemId(item))));
    this.next = page.next;
  }
}
