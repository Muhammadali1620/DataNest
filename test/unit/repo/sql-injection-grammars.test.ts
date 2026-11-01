// V13.6: SQL is highlighted inside strings of other languages, but only for a string the
// author marked. The grammars run on the real engine (vscode-textmate over Oniguruma);
// the host languages are small stand-ins that keep what matters: comments and strings.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../helpers/repo';
import { contributedGrammars, embeddedSql, sqlKeywords, tokenize } from '../../helpers/textmate';

const JS = 'source.js';
const TS = 'source.ts';
const PY = 'source.python';

describe('JavaScript and TypeScript', () => {
  for (const host of [JS, TS]) {
    describe(host, () => {
      it('colors a template tagged with sql', async () => {
        expect(await embeddedSql(host, 'const q = sql`SELECT * FROM t`;')).toEqual([
          'SELECT * FROM t',
        ]);
        expect(await embeddedSql(host, 'const q = SQL`select 1 from t`;')).toEqual([
          'select 1 from t',
        ]);
      });

      it('takes a type argument and a gap before the template', async () => {
        expect(await embeddedSql(host, 'const q = sql<Row>`select 1`;')).toEqual(['select 1']);
        expect(await embeddedSql(host, 'const q = sql `select 1`;')).toEqual(['select 1']);
      });

      it('follows a template over lines and leaves the code after it alone', async () => {
        const source = ['const q = sql`', '  SELECT a', '  FROM t', '`;', 'const n = 1;'].join(
          '\n',
        );
        expect(await embeddedSql(host, source)).toEqual(['  SELECT a', '  FROM t']);
        const lines = await tokenize(host, source);
        expect(lines[4]?.every((t) => !t.scopes.some((s) => s.includes('embedded-sql')))).toBe(
          true,
        );
      });

      it('leaves a substitution to the host language, not to SQL', async () => {
        const lines = await tokenize(host, 'sql`select a from t where id = ${id + 1} and b`');
        const expression = lines[0]?.filter((t) => t.scopes.includes('meta.template.expression'));
        expect(expression?.map((t) => t.text).join('')).toContain('id + 1');
        const innermost = (text: string): string | undefined =>
          lines[0]?.find((t) => t.text.includes(text))?.scopes.at(-1);
        expect(innermost('id')).not.toBe('keyword.other.sql');
        expect(await sqlKeywords(host, 'sql`select a from t where id = ${id} and b`')).toEqual([
          'select',
          'from',
          'where',
          'and',
        ]);
      });

      it('colors the string after a block comment marker', async () => {
        expect(await embeddedSql(host, 'run(/* sql */ "SELECT 1 FROM t");')).toEqual([
          'SELECT 1 FROM t',
        ]);
        expect(await embeddedSql(host, "run(/*sql*/'SELECT 1');")).toEqual(['SELECT 1']);
        expect(await embeddedSql(host, 'run(/* sql */ `SELECT 1`);')).toEqual(['SELECT 1']);
        expect(await embeddedSql(host, 'run(/* language=SQL */ "SELECT 1");')).toEqual([
          'SELECT 1',
        ]);
        expect(await embeddedSql(host, 'run(/* SQL */ "SELECT 1");')).toEqual(['SELECT 1']);
      });

      it('colors the string below a line comment marker', async () => {
        expect(await embeddedSql(host, '// language=SQL\nconst q = `SELECT 1 FROM t`;')).toEqual([
          'SELECT 1 FROM t',
        ]);
        expect(await embeddedSql(host, '// language=sql\nconst q = "select 1";')).toEqual([
          'select 1',
        ]);
        expect(await embeddedSql(host, '// sql\nconst q = `\n  select 1\n`;')).toEqual([
          '  select 1',
        ]);
        expect(await embeddedSql(host, '// LANGUAGE = SQL\nconst q = `select 1`;')).toEqual([
          'select 1',
        ]);
      });

      it('marks only the first string after the marker', async () => {
        expect(await embeddedSql(host, '// sql\nrun("select 1", "select 2");')).toEqual([
          'select 1',
        ]);
        expect(
          await embeddedSql(host, '// sql\nconst q = "select 1"; const r = "select 2";'),
        ).toEqual(['select 1']);
      });

      it('gives up when no string follows the marker', async () => {
        const source = ['// sql', 'const a = 1;', 'const q = "select 1";'].join('\n');
        expect(await embeddedSql(host, source)).toEqual([]);
      });

      it('keeps the host strings: the colored string is still a string', async () => {
        const lines = await tokenize(host, 'const q = sql`select 1`;');
        const select = lines[0]?.find((t) => t.text === 'select');
        expect(select?.scopes.some((scope) => scope.startsWith('string.template'))).toBe(true);
        expect(select?.scopes).toContain('keyword.other.sql');
        const quoted = await tokenize(host, '/* sql */ "select 1"');
        expect(quoted[0]?.find((t) => t.text === 'select')?.scopes).toContain('keyword.other.sql');
        expect(
          quoted[0]
            ?.find((t) => t.text === 'select')
            ?.scopes.some((s) => s.startsWith('string.quoted')),
        ).toBe(true);
      });

      it('takes escapes inside a quoted string, and ends at the end of the line', async () => {
        expect(await embeddedSql(host, 'x(/* sql */ "SELECT \\"a\\" FROM t");')).toEqual([
          'SELECT \\"a\\" FROM t',
        ]);
        const source = ['x(/* sql */ "SELECT', 'const y = 1;'].join('\n');
        expect(await embeddedSql(host, source)).toEqual(['SELECT']);
      });

      it('does nothing for a string without a marker', async () => {
        for (const source of [
          'const q = `SELECT * FROM t`;',
          'const q = "select 1";',
          "const q = 'select 1';",
          '/* just a comment */ "select 1"',
          '// sqlite notes\nconst q = "select 1";',
          'const q = sqlx`select 1`;',
          'const q = mysql`select 1`;',
          'const q = sql_text`select 1`;',
          'const q = sql(`select 1`);',
        ]) {
          expect(await embeddedSql(host, source), source).toEqual([]);
          expect(await sqlKeywords(host, source), source).toEqual([]);
        }
      });

      it('ignores a marker inside a comment or another string', async () => {
        for (const source of [
          '// see /* sql */ "select 1"',
          '/* a /* sql */ "select 1" */',
          'const t = "/* sql */ \\"select 1\\"";',
          'const t = `sql\\`select 1\\``;',
        ]) {
          expect(await embeddedSql(host, source), source).toEqual([]);
        }
      });

      it('leaves the lines after a coloured string as the host language reads them', async () => {
        const lines = await tokenize(
          host,
          ['// sql', 'const q = "select 1";', 'const w = "x";'].join('\n'),
        );
        const last = lines[2] ?? [];
        expect(last.some((t) => t.scopes.some((s) => s.includes('embedded-sql')))).toBe(false);
        expect(
          last.find((t) => t.text === 'x')?.scopes.some((s) => s.startsWith('string.quoted')),
        ).toBe(true);
        expect(last.find((t) => t.text === 'const')?.scopes).toContain('keyword.control');
      });
    });
  }

  it('reads JSX hosts too', async () => {
    expect(await embeddedSql('source.js.jsx', 'const q = sql`select 1`;')).toEqual(['select 1']);
    expect(await embeddedSql('source.tsx', 'const q = sql`select 1`;')).toEqual(['select 1']);
  });
});

describe('Python', () => {
  it('colors a triple-quoted string below a # marker', async () => {
    const source = ['# sql', 'q = """', '  SELECT a', '  FROM t', '"""', 'x = 1'].join('\n');
    expect(await embeddedSql(PY, source)).toEqual(['  SELECT a', '  FROM t']);
  });

  it('knows # language=sql, single quotes and string prefixes', async () => {
    expect(await embeddedSql(PY, "# language=SQL\nq = '''select 1'''")).toEqual(['select 1']);
    expect(await embeddedSql(PY, '# sql\nq = r"""select 1"""')).toEqual(['select 1']);
    expect(await embeddedSql(PY, '# sql\nq = f"""select {n}"""')).toEqual(['select {n}']);
    expect(await embeddedSql(PY, '# sql\nq = b"select 1"')).toEqual(['select 1']);
  });

  it('colors a one-line string below the marker', async () => {
    expect(await embeddedSql(PY, '# sql\nq = "select 1 from t"')).toEqual(['select 1 from t']);
    expect(await embeddedSql(PY, "# sql\nq = 'select 1'")).toEqual(['select 1']);
    expect(await embeddedSql(PY, '# sql\ncur.execute("select 1")')).toEqual(['select 1']);
  });

  it('does not touch a string without a marker or a marker without a string', async () => {
    for (const source of [
      'q = """SELECT 1"""',
      'q = "select 1"',
      '# sqlite is fine\nq = "select 1"',
      '# sql\nx = 1\nq = "select 1"',
      '"""# sql\n"select 1"\n"""',
      '"# sql"',
    ]) {
      expect(await embeddedSql(PY, source), source).toEqual([]);
    }
  });

  it('ends at the closing quotes, whichever kind opened', async () => {
    const source = ['# sql', "q = '''", '  select \'"""\' ', "'''", 'y = """not sql"""'].join('\n');
    expect(await embeddedSql(PY, source)).toEqual(['', '  select \'"""\' '].filter(Boolean));
    const last = (await tokenize(PY, source)).at(-1) ?? [];
    expect(last.some((t) => t.scopes.some((s) => s.includes('embedded-sql')))).toBe(false);
  });
});

describe('Go', () => {
  const GO = 'source.go';

  it('colors a raw string below a marker or after a block comment', async () => {
    expect(await embeddedSql(GO, '// language=SQL\nconst q = `\n  SELECT 1\n`')).toEqual([
      '  SELECT 1',
    ]);
    expect(await embeddedSql(GO, 'rows, _ := db.Query(/* sql */ `SELECT 1`)')).toEqual([
      'SELECT 1',
    ]);
    expect(await embeddedSql(GO, '// sql\nconst q = "select 1"')).toEqual(['select 1']);
  });

  it('takes a backslash in a raw string as it is', async () => {
    expect(await embeddedSql(GO, "// sql\nq := `select 'a\\' from t`")).toEqual([
      "select 'a\\' from t",
    ]);
    const last = (await tokenize(GO, "// sql\nq := `select 'a\\' from t`\nx := 1")).at(-1) ?? [];
    expect(last.some((t) => t.scopes.some((s) => s.includes('embedded-sql')))).toBe(false);
  });

  it('does nothing without a marker', async () => {
    expect(await embeddedSql(GO, 'q := `select 1`')).toEqual([]);
    expect(await embeddedSql(GO, '// query\nq := `select 1`')).toEqual([]);
  });
});

describe('PHP', () => {
  const PHP = 'source.php';

  it('colors a heredoc and a nowdoc named SQL', async () => {
    const source = ['$q = <<<SQL', '  SELECT 1', '  FROM t', 'SQL;', '$x = 1;'].join('\n');
    expect(await embeddedSql(PHP, source)).toEqual(['  SELECT 1', '  FROM t']);
    expect(await embeddedSql(PHP, "$q = <<<'SQL'\n  select 1\nSQL;")).toEqual(['  select 1']);
    expect(await embeddedSql(PHP, '$q = <<<"sql"\n  select 1\n  sql;')).toEqual(['  select 1']);
  });

  it('ends the heredoc at its closing line', async () => {
    const lines = await tokenize(PHP, '$q = <<<SQL\n select 1\nSQL;\n$w = "x";');
    const after = lines.at(-1) ?? [];
    expect(after.some((t) => t.scopes.some((s) => s.includes('embedded-sql')))).toBe(false);
    expect(
      after.find((t) => t.text === 'x')?.scopes.some((s) => s.startsWith('string.quoted')),
    ).toBe(true);
  });

  it('leaves a heredoc of another name alone', async () => {
    expect(await embeddedSql(PHP, '$q = <<<EOT\n select 1\nEOT;')).toEqual([]);
    expect(await embeddedSql(PHP, '$q = <<<SQLITE\n select 1\nSQLITE;')).toEqual([]);
  });

  it('knows the // and # markers and a block comment', async () => {
    expect(await embeddedSql(PHP, '// sql\n$q = "select 1";')).toEqual(['select 1']);
    expect(await embeddedSql(PHP, "# language=SQL\n$q = 'select 1';")).toEqual(['select 1']);
    expect(await embeddedSql(PHP, '$db->query(/* sql */ "select 1");')).toEqual(['select 1']);
    expect(await embeddedSql(PHP, '$q = "select 1";')).toEqual([]);
  });
});

describe('Java, Kotlin and C#', () => {
  const cases: [string, string][] = [
    ['Java', 'source.java'],
    ['Kotlin', 'source.kotlin'],
    ['C#', 'source.cs'],
  ];
  for (const [name, host] of cases) {
    describe(name, () => {
      it('colors a text block below a marker', async () => {
        const source = [
          '// language=SQL',
          'String q = """',
          '  SELECT 1',
          '  FROM t',
          '""";',
          'int n;',
        ].join('\n');
        expect(await embeddedSql(host, source)).toEqual(['  SELECT 1', '  FROM t']);
      });

      it('colors a string after a block comment', async () => {
        expect(await embeddedSql(host, 'run(/* sql */ "select 1");')).toEqual(['select 1']);
        expect(await embeddedSql(host, 'run(/* sql */ """select 1""");')).toEqual(['select 1']);
      });

      it('does nothing without a marker', async () => {
        expect(await embeddedSql(host, 'String q = """\n select 1\n""";')).toEqual([]);
        expect(await embeddedSql(host, 'run("select 1");')).toEqual([]);
      });
    });
  }
});

describe('the contributed grammars', () => {
  const injections = contributedGrammars().filter((grammar) =>
    grammar.scopeName.startsWith('datanest.sql-injection.'),
  );

  it('cover each language once and point at files that ship', () => {
    expect(injections.map((grammar) => grammar.scopeName).sort()).toEqual([
      'datanest.sql-injection.csharp',
      'datanest.sql-injection.go',
      'datanest.sql-injection.java',
      'datanest.sql-injection.javascript',
      'datanest.sql-injection.kotlin',
      'datanest.sql-injection.php',
      'datanest.sql-injection.python',
      'datanest.sql-injection.typescript',
    ]);
    for (const grammar of injections) {
      const file = JSON.parse(readFileSync(join(ROOT, grammar.path), 'utf8')) as {
        scopeName: string;
        injectionSelector: string;
      };
      expect(file.scopeName).toBe(grammar.scopeName);
      expect(grammar.path).toMatch(
        /^\.\/resources\/syntaxes\/datanest-sql-in-[a-z]+\.tmLanguage\.json$/,
      );
    }
  });

  it('inject only into the languages the editor ships, and nothing in the language they replace', () => {
    const hosts = injections.flatMap((grammar) => grammar.injectTo ?? []).sort();
    expect(hosts).toEqual([
      'source.cs',
      'source.go',
      'source.java',
      'source.js',
      'source.js.jsx',
      'source.kotlin',
      'source.php',
      'source.python',
      'source.ts',
      'source.tsx',
    ]);
    for (const grammar of injections) {
      expect(grammar).not.toHaveProperty('language');
    }
  });

  it('hand the embedded block to the sql language, and only that', () => {
    for (const grammar of injections) {
      expect(grammar.embeddedLanguages).toMatchObject({ 'meta.embedded.block.sql': 'sql' });
    }
  });

  it('select the host only outside comments and strings, with priority over its own rules', () => {
    for (const grammar of injections) {
      const file = JSON.parse(readFileSync(join(ROOT, grammar.path), 'utf8')) as {
        injectionSelector: string;
      };
      for (const part of file.injectionSelector.split(',')) {
        expect(part.trim()).toMatch(/^L:source\.[a-z.]+ -comment -string$/);
      }
      expect(
        file.injectionSelector
          .split(',')
          .map((part) => part.trim().split(' ')[0]?.slice(2))
          .sort(),
      ).toEqual([...(grammar.injectTo ?? [])].sort());
    }
  });

  it('reach SQL only through the editor’s own source.sql, never a grammar of ours', () => {
    for (const grammar of injections) {
      const text = readFileSync(join(ROOT, grammar.path), 'utf8');
      const includes = [...text.matchAll(/"include":\s*"([^"]+)"/g)].map((match) => match[1]);
      expect(includes).toContain('source.sql');
      for (const include of includes) {
        expect(include).toMatch(/^source\.(sql|js|ts)$/);
      }
    }
  });
});
