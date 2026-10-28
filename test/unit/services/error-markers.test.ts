import { describe, expect, it } from 'vitest';
import { errorMarkers } from '../../../src/services/error-markers';

const TEXT = 'SELECT 1;\nSELEC 2;\nSELECT x FROM t;';

function failed(statement: string, code: string, position?: number) {
  return {
    statement,
    statementStart: TEXT.indexOf(statement),
    error: { code, message: `${code}!`, ...(position === undefined ? {} : { position }) },
  };
}

describe('errorMarkers', () => {
  it('marks the word at the position the server gave', () => {
    expect(errorMarkers(TEXT, [failed('SELECT x FROM t', 'not-found', 7)], 'sqlite')).toEqual([
      {
        start: TEXT.indexOf('x FROM'),
        end: TEXT.indexOf('x FROM') + 1,
        message: 'not-found!',
        code: 'not-found',
      },
    ]);
  });

  it('marks the whole statement when the position is unknown or impossible', () => {
    const whole = { start: TEXT.indexOf('SELEC 2'), end: TEXT.indexOf('SELEC 2') + 7 };
    expect(errorMarkers(TEXT, [failed('SELEC 2', 'syntax')], 'mysql')).toEqual([
      { ...whole, message: 'syntax!', code: 'syntax' },
    ]);
    expect(errorMarkers(TEXT, [failed('SELEC 2', 'syntax', 99)], 'mysql')[0]).toMatchObject(whole);
  });

  it('takes the next word when the position falls on a space, and the last character at the end', () => {
    const at = TEXT.indexOf('SELEC 2');
    expect(errorMarkers(TEXT, [failed('SELEC 2', 'syntax', 5)], 'mysql')[0]).toMatchObject({
      start: at + 6,
      end: at + 7,
    });
    expect(errorMarkers(TEXT, [failed('SELEC 2', 'syntax', 7)], 'mysql')[0]).toMatchObject({
      start: at + 6,
      end: at + 7,
    });
  });

  it('skips statements that ran fine and errors that are not about the text', () => {
    const ok = { statement: 'SELECT 1', statementStart: 0 };
    expect(
      errorMarkers(
        TEXT,
        [
          ok,
          ...['cancelled', 'timeout', 'connection-failed', 'auth-failed', 'busy'].map((code) =>
            failed('SELEC 2', code),
          ),
        ],
        'mysql',
      ),
    ).toEqual([]);
  });

  it('skips a statement whose text moved since it ran', () => {
    expect(
      errorMarkers(TEXT, [{ ...failed('SELEC 2', 'syntax'), statementStart: 0 }], 'mysql'),
    ).toEqual([]);
  });
});
