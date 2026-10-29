import { describe, expect, it } from 'vitest';
import {
  isTrivia,
  scriptTerminator,
  syntaxOf,
  textOf,
  tokenize,
  type Token,
  type TokenKind,
} from '../../../../src/core/sql/tokenizer';
import type { DriverId } from '../../../../src/shared/connection';

/** Tokens as `kind:text` pairs, which reads much better in expectations. */
function shape(sql: string, driver?: DriverId): string[] {
  return tokenize(sql, syntaxOf(driver)).map((token) => `${token.kind}:${textOf(sql, token)}`);
}

function kinds(sql: string, driver?: DriverId): TokenKind[] {
  return tokenize(sql, syntaxOf(driver)).map((token) => token.kind);
}

function only(sql: string, kind: TokenKind, driver?: DriverId): Token[] {
  return tokenize(sql, syntaxOf(driver)).filter((token) => token.kind === kind);
}

/** Text of the first token of a kind; fails loudly when there is none. */
function firstText(sql: string, kind: TokenKind, driver?: DriverId): string {
  const [token] = only(sql, kind, driver);
  if (token === undefined) {
    throw new Error(`No ${kind} token in: ${sql}`);
  }
  return textOf(sql, token);
}

describe('tokenize', () => {
  it('covers the whole input with tokens, in order and without gaps', () => {
    const sql = "SELECT 'a', 1.5 -- note\nFROM t;";
    const tokens = tokenize(sql);
    expect(tokens[0]?.start).toBe(0);
    expect(tokens.at(-1)?.end).toBe(sql.length);
    for (const [index, token] of tokens.entries()) {
      expect(token.end).toBeGreaterThan(token.start);
      if (index > 0) {
        expect(token.start).toBe(tokens[index - 1]?.end);
      }
    }
  });

  it('reads words, numbers, punctuation and whitespace', () => {
    expect(shape('SELECT a1, 42')).toEqual([
      'word:SELECT',
      'whitespace: ',
      'word:a1',
      'punctuation:,',
      'whitespace: ',
      'number:42',
    ]);
  });

  it('reads numbers with decimals and exponents', () => {
    expect(shape('1 1.5 .5 1e3 1.5E-2 1e')).toEqual([
      'number:1',
      'whitespace: ',
      'number:1.5',
      'whitespace: ',
      'number:.5',
      'whitespace: ',
      'number:1e3',
      'whitespace: ',
      'number:1.5E-2',
      'whitespace: ',
      // A dangling exponent is not part of the number.
      'number:1',
      'word:e',
    ]);
  });

  it('accepts unicode identifiers', () => {
    expect(shape('SELECT таблица, 日本語 FROM t')).toContain('word:таблица');
    expect(shape('SELECT таблица, 日本語 FROM t')).toContain('word:日本語');
  });

  describe('comments', () => {
    it('reads line comments up to the newline, which stays whitespace', () => {
      expect(shape('-- hi\nSELECT 1')).toEqual([
        'comment:-- hi',
        'whitespace:\n',
        'word:SELECT',
        'whitespace: ',
        'number:1',
      ]);
    });

    it('reads a line comment that runs to the end of input', () => {
      expect(shape('SELECT 1 -- tail')).toContain('comment:-- tail');
    });

    it('treats # as a comment only where the dialect says so', () => {
      expect(kinds('# hi\nSELECT 1', 'mysql')[0]).toBe('comment');
      expect(kinds('# hi\nSELECT 1', 'postgres')[0]).toBe('punctuation');
    });

    it('reads block comments, including multi-line ones', () => {
      expect(shape('/* a\nb */ SELECT 1')).toContain('comment:/* a\nb */');
    });

    it('nests block comments only in PostgreSQL', () => {
      const sql = '/* a /* b */ still */ SELECT 1';
      expect(firstText(sql, 'comment', 'postgres')).toBe('/* a /* b */ still */');
      expect(firstText(sql, 'comment', 'mysql')).toBe('/* a /* b */');
    });

    it('marks an unterminated block comment', () => {
      const sql = '/* never closed';
      const [token] = tokenize(sql);
      expect(token).toMatchObject({ kind: 'comment', unterminated: true, end: sql.length });
    });
  });

  describe('strings', () => {
    it('keeps a doubled quote inside the string', () => {
      const sql = "SELECT 'O''Brien'";
      expect(firstText(sql, 'string')).toBe("'O''Brien'");
    });

    it('honours backslash escapes only in MySQL', () => {
      const sql = "SELECT 'a\\' , 'b'";
      // MySQL: the escaped quote stays inside, so the string runs on to the next one.
      expect(firstText(sql, 'string', 'mysql')).toBe("'a\\' , '");
      // PostgreSQL: the backslash is an ordinary character, so the string ends early
      // and `'b'` is a string of its own.
      expect(only(sql, 'string', 'postgres').map((token) => textOf(sql, token))).toEqual([
        "'a\\'",
        "'b'",
      ]);
    });

    it('reads PostgreSQL E-strings with backslash escapes, prefix included', () => {
      const sql = "SELECT E'it\\'s; here', e'\\\\', 'plain\\'";
      expect(only(sql, 'string', 'postgres').map((token) => textOf(sql, token))).toEqual([
        "E'it\\'s; here'",
        "e'\\\\'",
        "'plain\\'",
      ]);
    });

    it('keeps a word that ends in E apart from the string after it', () => {
      const sql = "SELECT nameE'x'";
      expect(shape(sql, 'postgres')).toContain('word:nameE');
      expect(firstText(sql, 'string', 'postgres')).toBe("'x'");
    });

    it('reads E as a name before a quote in dialects without E-strings', () => {
      expect(shape("SELECT E'a\\'", 'mysql')).toContain('word:E');
      expect(shape("SELECT E'a\\'", 'sqlite')).toContain('word:E');
    });

    it('does not end a string at a semicolon or a comment marker', () => {
      const sql = "SELECT 'a; -- b /* c */'";
      expect(only(sql, 'string')).toHaveLength(1);
      expect(only(sql, 'comment')).toHaveLength(0);
    });

    it('marks an unterminated string', () => {
      const sql = "SELECT 'open";
      expect(only(sql, 'string')[0]).toMatchObject({ unterminated: true, end: sql.length });
    });

    it('treats double quotes as names or as text per dialect', () => {
      expect(only('SELECT "a"', 'quoted-identifier', 'postgres')).toHaveLength(1);
      expect(only('SELECT "a"', 'string', 'mysql')).toHaveLength(1);
    });

    it('reads backtick names where the dialect has them', () => {
      const sql = 'SELECT `we``ird` FROM t';
      expect(firstText(sql, 'quoted-identifier', 'mysql')).toBe('`we``ird`');
      expect(only(sql, 'quoted-identifier', 'postgres')).toHaveLength(0);
    });
  });

  describe('dollar quoting', () => {
    it('reads $$ … $$ bodies as one string in PostgreSQL', () => {
      const sql = '$$ BEGIN; END; $$';
      expect(firstText(sql, 'string', 'postgres')).toBe(sql);
    });

    it('reads tagged bodies and ignores a different tag inside', () => {
      const sql = '$body$ SELECT $other$ x $body$';
      expect(firstText(sql, 'string', 'postgres')).toBe(sql);
    });

    it('marks an unterminated body', () => {
      const sql = '$body$ never closed';
      expect(only(sql, 'string', 'postgres')[0]).toMatchObject({ unterminated: true });
    });

    it('leaves a lone $ as punctuation', () => {
      expect(kinds('$1', 'postgres')[0]).toBe('punctuation');
    });

    it('does not dollar-quote where the dialect has no such thing', () => {
      expect(only('$$ x $$', 'string', 'mysql')).toHaveLength(0);
    });
  });

  describe('syntaxOf', () => {
    it('describes each driver', () => {
      expect(syntaxOf('mysql')).toMatchObject({
        backslashEscapes: true,
        hashComments: true,
        backtickIdentifiers: true,
        doubleQuoteIdentifiers: false,
        dollarQuotes: false,
        delimiterCommand: true,
      });
      expect(syntaxOf('postgres')).toMatchObject({
        backslashEscapes: false,
        dollarQuotes: true,
        nestedBlockComments: true,
        delimiterCommand: false,
      });
      expect(syntaxOf('sqlite')).toMatchObject({
        backtickIdentifiers: true,
        doubleQuoteIdentifiers: true,
        dollarQuotes: false,
      });
    });

    it('without a driver accepts every quoting style, so nothing reads as code', () => {
      const permissive = syntaxOf();
      expect(permissive.backtickIdentifiers).toBe(true);
      expect(permissive.doubleQuoteIdentifiers).toBe(true);
      expect(permissive.dollarQuotes).toBe(true);
      // Backslash escapes are the risky one: assuming them would swallow text.
      expect(permissive.backslashEscapes).toBe(false);
    });
  });

  describe('helpers', () => {
    it('isTrivia covers whitespace and comments only', () => {
      const tokens = tokenize("SELECT 'a' -- c\n");
      expect(tokens.filter(isTrivia).map((token) => token.kind)).toEqual([
        'whitespace',
        'whitespace',
        'comment',
        'whitespace',
      ]);
    });

    it('textOf returns the source slice', () => {
      expect(firstText('SELECT 1', 'word')).toBe('SELECT');
    });
  });

  it('returns nothing for empty input', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('tokenize: SQL Server (V6.2)', () => {
  it('reads [bracketed] names as quoted identifiers, ]] standing for one ]', () => {
    expect(shape('SELECT [a]]b] FROM [dbo].[t;x]', 'mssql')).toEqual([
      'word:SELECT',
      'whitespace: ',
      'quoted-identifier:[a]]b]',
      'whitespace: ',
      'word:FROM',
      'whitespace: ',
      'quoted-identifier:[dbo]',
      'punctuation:.',
      'quoted-identifier:[t;x]',
    ]);
  });

  it('marks an unclosed bracket as unterminated to the end', () => {
    const [token] = only('SELECT [open; SELECT 2', 'quoted-identifier', 'mssql');
    expect(token?.unterminated).toBe(true);
    expect(token?.end).toBe('SELECT [open; SELECT 2'.length);
  });

  it('keeps double quotes as identifiers and N strings as strings', () => {
    expect(firstText('SELECT "a b"', 'quoted-identifier', 'mssql')).toBe('"a b"');
    expect(firstText("SELECT N'текст'", 'string', 'mssql')).toBe("'текст'");
  });

  it('nests block comments', () => {
    expect(kinds('/* a /* b */ c */ SELECT', 'mssql')).toEqual(['comment', 'whitespace', 'word']);
  });

  it('has no backticks, $$ bodies or backslash escapes', () => {
    expect(kinds('`x`', 'mssql')[0]).toBe('punctuation');
    expect(firstText("SELECT 'a\\'", 'string', 'mssql')).toBe("'a\\'");
  });

  it('is the only syntax with brackets and batch separators', () => {
    expect(syntaxOf('mssql')).toMatchObject({ bracketIdentifiers: true, batchSeparator: true });
    for (const driver of [undefined, 'mysql', 'postgres', 'sqlite'] as const) {
      expect(syntaxOf(driver)).toMatchObject({ bracketIdentifiers: false, batchSeparator: false });
    }
    // An array subscript in PostgreSQL stays punctuation.
    expect(kinds('a[1]')).toEqual(['word', 'punctuation', 'number', 'punctuation']);
  });
});

describe('tokenize: ClickHouse (V6.3)', () => {
  it('reads backslash escapes inside strings, so a quoted quote does not end it', () => {
    expect(firstText("SELECT 'O\\'Brien; x' FROM t", 'string', 'clickhouse')).toBe(
      "'O\\'Brien; x'",
    );
  });

  it('treats # as a line comment', () => {
    expect(kinds('SELECT 1 # note; here\nFROM t', 'clickhouse')).toContain('comment');
    expect(firstText('SELECT 1 # note; here\nFROM t', 'comment', 'clickhouse')).toBe(
      '# note; here',
    );
  });

  it('quotes identifiers with backticks and double quotes', () => {
    expect(firstText('SELECT `a;b` FROM t', 'quoted-identifier', 'clickhouse')).toBe('`a;b`');
    expect(firstText('SELECT "a;b" FROM t', 'quoted-identifier', 'clickhouse')).toBe('"a;b"');
  });

  it('reads $heredoc$ strings as one string', () => {
    expect(firstText('SELECT $doc$a;b$doc$', 'string', 'clickhouse')).toBe('$doc$a;b$doc$');
  });

  it('has no brackets and no GO lines', () => {
    expect(syntaxOf('clickhouse')).toMatchObject({
      backslashEscapes: true,
      hashComments: true,
      backtickIdentifiers: true,
      doubleQuoteIdentifiers: true,
      dollarQuotes: true,
      bracketIdentifiers: false,
      batchSeparator: false,
    });
  });
});

describe('tokenize: Oracle (V6.4)', () => {
  it('has double-quoted names, `/` lines and q-quotes, but no backslashes or hashes', () => {
    expect(syntaxOf('oracle')).toMatchObject({
      doubleQuoteIdentifiers: true,
      slashTerminator: true,
      quoteOperator: true,
      backslashEscapes: false,
      hashComments: false,
      backtickIdentifiers: false,
      dollarQuotes: false,
      bracketIdentifiers: false,
      batchSeparator: false,
      delimiterCommand: false,
    });
    expect(firstText("SELECT 'a\\'", 'string', 'oracle')).toBe("'a\\'");
    expect(kinds('# x', 'oracle')[0]).toBe('punctuation');
  });

  it('reads q-quoted strings with bracket pairs as closing delimiters', () => {
    expect(firstText("SELECT q'[it's; here]' FROM dual", 'string', 'oracle')).toBe(
      "q'[it's; here]'",
    );
    expect(firstText("SELECT q'{a}b}' FROM dual", 'string', 'oracle')).toBe("q'{a}b}'");
    expect(firstText("SELECT Q'(x ' y)' FROM dual", 'string', 'oracle')).toBe("Q'(x ' y)'");
    expect(firstText("SELECT q'<a > b>' FROM dual", 'string', 'oracle')).toBe("q'<a > b>'");
  });

  it('reads q-quoted strings closed by the same character they open with', () => {
    expect(firstText("SELECT q'!it's!' FROM dual", 'string', 'oracle')).toBe("q'!it's!'");
    expect(firstText("SELECT q'#a]b#' FROM dual", 'string', 'oracle')).toBe("q'#a]b#'");
  });

  it('reads national nq and Nq strings as one string each', () => {
    expect(shape("SELECT nq'[n;1]', Nq'#k#' FROM dual", 'oracle')).toEqual([
      'word:SELECT',
      'whitespace: ',
      "string:nq'[n;1]'",
      'punctuation:,',
      'whitespace: ',
      "string:Nq'#k#'",
      'whitespace: ',
      'word:FROM',
      'whitespace: ',
      'word:dual',
    ]);
  });

  it('keeps line breaks and slashes inside a q-quoted string', () => {
    expect(firstText("q'[a\n/\nb]'", 'string', 'oracle')).toBe("q'[a\n/\nb]'");
  });

  it('marks an unclosed q-quoted string as unterminated to the end', () => {
    const sql = "SELECT q'[never ends]";
    expect(firstText(sql, 'string', 'oracle')).toBe("q'[never ends]");
    const [token] = only(sql, 'string', 'oracle');
    expect(token?.unterminated).toBe(true);
    expect(token?.end).toBe(sql.length);
  });

  it('does not take q followed by a quote and whitespace for a q-quote', () => {
    expect(shape("SELECT q' x' FROM dual", 'oracle').slice(2, 4)).toEqual([
      'word:q',
      "string:' x'",
    ]);
    expect(shape("SELECT q'", 'oracle').slice(2)).toEqual(['word:q', "string:'"]);
  });

  it('reads q-quotes only in Oracle', () => {
    for (const driver of [
      undefined,
      'mysql',
      'postgres',
      'sqlite',
      'mssql',
      'clickhouse',
    ] as const) {
      expect(syntaxOf(driver).quoteOperator, String(driver)).toBe(false);
      expect(syntaxOf(driver).slashTerminator, String(driver)).toBe(false);
      expect(shape("q'[a]'", driver).slice(0, 2), String(driver)).toEqual([
        'word:q',
        "string:'[a]'",
      ]);
    }
  });
});

describe('scriptTerminator (V6.4)', () => {
  it('ends statements with GO for SQL Server and `/` for Oracle', () => {
    expect(scriptTerminator(syntaxOf('mssql'))).toBe('GO');
    expect(scriptTerminator(syntaxOf('oracle'))).toBe('/');
  });

  it('needs no terminator line elsewhere', () => {
    for (const driver of [undefined, 'mysql', 'postgres', 'sqlite', 'clickhouse'] as const) {
      expect(scriptTerminator(syntaxOf(driver)), String(driver)).toBeUndefined();
    }
  });
});
