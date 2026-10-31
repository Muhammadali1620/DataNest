import { describe, expect, it } from 'vitest';
import {
  BindingMemory,
  isKeptDocument,
  MAX_REMEMBERED_FILES,
  SAVE_AS_MAX_TEXT,
  SAVE_AS_WINDOW_MS,
  SaveAsMatcher,
} from '../../../src/services/binding-memory';
import { FakeMemento } from '../../helpers/fakes';

const FILE = 'file:///work/report.sql';
const OTHER = 'file:///work/other.sql';

describe('isKeptDocument', () => {
  it('keeps files, local and remote', () => {
    expect(isKeptDocument(FILE)).toBe(true);
    expect(isKeptDocument('vscode-remote://ssh-remote%2Bbox/home/me/a.sql')).toBe(true);
  });

  it('does not keep untitled buffers and views of other things', () => {
    for (const uri of ['untitled:Untitled-1', 'git:/work/a.sql', 'datanest-ddl:/t.sql', '']) {
      expect(isKeptDocument(uri)).toBe(false);
    }
  });
});

describe('BindingMemory', () => {
  it('gives back the binding of a file, with and without a database', async () => {
    const memory = new BindingMemory(new FakeMemento());
    await memory.remember(FILE, { connectionId: 'c1', database: 'shop' });
    await memory.remember(OTHER, { connectionId: 'c2' });
    expect(memory.get(FILE)).toEqual({ connectionId: 'c1', database: 'shop' });
    expect(memory.get(OTHER)).toEqual({ connectionId: 'c2' });
    expect(memory.get('file:///unknown.sql')).toBeUndefined();
  });

  it('keeps bindings across instances on the same state, as after a restart', async () => {
    const state = new FakeMemento();
    await new BindingMemory(state).remember(FILE, { connectionId: 'c1' });
    expect(new BindingMemory(state).get(FILE)).toEqual({ connectionId: 'c1' });
  });

  it('replaces the binding when the file is pointed elsewhere', async () => {
    const memory = new BindingMemory(new FakeMemento());
    await memory.remember(FILE, { connectionId: 'c1', database: 'a' });
    await memory.remember(FILE, { connectionId: 'c1' });
    expect(memory.get(FILE)).toEqual({ connectionId: 'c1' });
  });

  it('does not keep untitled documents', async () => {
    const state = new FakeMemento();
    await new BindingMemory(state).remember('untitled:Untitled-1', { connectionId: 'c1' });
    expect(state.data.size).toBe(0);
  });

  it('does not write when nothing changed', async () => {
    const state = new FakeMemento();
    const memory = new BindingMemory(state);
    await memory.remember(FILE, { connectionId: 'c1' });
    let writes = 0;
    const update = state.update.bind(state);
    state.update = (key, value) => {
      writes++;
      return update(key, value);
    };
    await memory.remember(FILE, { connectionId: 'c1' });
    expect(writes).toBe(0);
  });

  it('stores only the connection and the database', async () => {
    const state = new FakeMemento();
    const memory = new BindingMemory(state);
    const extra = { connectionId: 'c1', database: 'a', schema: 'x' } as const;
    await memory.remember(FILE, extra);
    expect(state.data.get('datanest.documentBindings')).toEqual([
      [FILE, { connectionId: 'c1', database: 'a' }],
    ]);
  });

  it('forgets the files bound longest ago past the limit', async () => {
    const memory = new BindingMemory(new FakeMemento());
    for (let index = 0; index < MAX_REMEMBERED_FILES + 2; index++) {
      await memory.remember(`file:///q${index}.sql`, { connectionId: 'c' });
    }
    expect(memory.get('file:///q0.sql')).toBeUndefined();
    expect(memory.get('file:///q1.sql')).toBeUndefined();
    expect(memory.get('file:///q2.sql')).toEqual({ connectionId: 'c' });
    // Binding an old file again makes it the newest.
    await memory.remember('file:///q2.sql', { connectionId: 'd' });
    await memory.remember('file:///new.sql', { connectionId: 'c' });
    expect(memory.get('file:///q2.sql')).toEqual({ connectionId: 'd' });
    expect(memory.get('file:///q3.sql')).toBeUndefined();
  });

  it('moves a binding with its file', async () => {
    const memory = new BindingMemory(new FakeMemento());
    await memory.remember(FILE, { connectionId: 'c1' });
    await memory.remember(OTHER, { connectionId: 'c2' });
    await memory.rename(FILE, OTHER);
    expect(memory.get(FILE)).toBeUndefined();
    expect(memory.get(OTHER)).toEqual({ connectionId: 'c1' });
  });

  it('drops a binding whose file moved out of the files it keeps, and ignores unknown ones', async () => {
    const state = new FakeMemento();
    const memory = new BindingMemory(state);
    await memory.rename(FILE, OTHER);
    expect(state.data.size).toBe(0);
    await memory.remember(FILE, { connectionId: 'c1' });
    await memory.rename(FILE, 'untitled:x');
    expect(memory.get(FILE)).toBeUndefined();
    expect(memory.get('untitled:x')).toBeUndefined();
  });

  it('ignores a state it does not recognise', () => {
    for (const stored of [
      { [FILE]: { connectionId: 'c' } },
      [[FILE]],
      [[FILE, { connectionId: '' }]],
      [[FILE, { connectionId: 'c', database: 1 }]],
      [[FILE, null]],
      [[1, { connectionId: 'c' }]],
      'x',
    ]) {
      const memory = new BindingMemory(
        new FakeMemento(new Map([['datanest.documentBindings', stored]])),
      );
      expect(memory.get(FILE)).toBeUndefined();
    }
  });
});

describe('SaveAsMatcher', () => {
  function clock(): { now: () => number; advance: (ms: number) => void } {
    let time = 1_000_000;
    return {
      now: () => time,
      advance: (ms) => {
        time += ms;
      },
    };
  }

  it('hands the binding of a closed query to the file that opens with its text', () => {
    const matcher = new SaveAsMatcher(clock().now);
    expect(
      matcher.untitledClosed('SELECT 1', { connectionId: 'c1', database: 'a' }),
    ).toBeUndefined();
    expect(matcher.fileOpened(FILE, 'SELECT 1')).toEqual({ connectionId: 'c1', database: 'a' });
    // Used up: another file with the same text gets nothing.
    expect(matcher.fileOpened(OTHER, 'SELECT 1')).toBeUndefined();
  });

  it('works the other way round: the file opens first, then the query closes', () => {
    const matcher = new SaveAsMatcher(clock().now);
    expect(matcher.fileOpened(FILE, 'SELECT 2')).toBeUndefined();
    expect(matcher.untitledClosed('SELECT 2', { connectionId: 'c1' })).toBe(FILE);
    expect(matcher.untitledClosed('SELECT 2', { connectionId: 'c1' })).toBeUndefined();
  });

  it('matches only the same text', () => {
    const matcher = new SaveAsMatcher(clock().now);
    matcher.untitledClosed('SELECT 1', { connectionId: 'c1' });
    expect(matcher.fileOpened(FILE, 'SELECT 1 ')).toBeUndefined();
    expect(matcher.fileOpened(OTHER, 'SELECT 1')).toEqual({ connectionId: 'c1' });
  });

  it('forgets what is older than a few seconds', () => {
    const time = clock();
    const matcher = new SaveAsMatcher(time.now);
    matcher.untitledClosed('SELECT 1', { connectionId: 'c1' });
    matcher.fileOpened(FILE, 'SELECT 2');
    time.advance(SAVE_AS_WINDOW_MS + 1);
    expect(matcher.fileOpened(OTHER, 'SELECT 1')).toBeUndefined();
    expect(matcher.untitledClosed('SELECT 2', { connectionId: 'c2' })).toBeUndefined();
  });

  it('still matches right at the edge of the window', () => {
    const time = clock();
    const matcher = new SaveAsMatcher(time.now);
    matcher.untitledClosed('SELECT 1', { connectionId: 'c1' });
    time.advance(SAVE_AS_WINDOW_MS);
    expect(matcher.fileOpened(FILE, 'SELECT 1')).toEqual({ connectionId: 'c1' });
  });

  it('pairs several queries with their own files', () => {
    const matcher = new SaveAsMatcher(clock().now);
    matcher.untitledClosed('A', { connectionId: 'a' });
    matcher.untitledClosed('B', { connectionId: 'b' });
    expect(matcher.fileOpened(OTHER, 'B')).toEqual({ connectionId: 'b' });
    expect(matcher.fileOpened(FILE, 'A')).toEqual({ connectionId: 'a' });
  });

  it('neither holds nor matches huge texts', () => {
    const matcher = new SaveAsMatcher(clock().now);
    const huge = 'x'.repeat(SAVE_AS_MAX_TEXT + 1);
    expect(matcher.untitledClosed(huge, { connectionId: 'c1' })).toBeUndefined();
    expect(matcher.fileOpened(FILE, huge)).toBeUndefined();
    expect(matcher.untitledClosed(huge, { connectionId: 'c1' })).toBeUndefined();
  });
});
