// Tokenizes text with the engine the editor itself uses (vscode-textmate over Oniguruma),
// so the injection grammars of V13.6 are tested as they run, not as regular expressions.
// The host languages and SQL are small stand-ins: the real grammars belong to the editor.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  INITIAL,
  parseRawGrammar,
  Registry,
  type IGrammar,
  type IRawGrammar,
} from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';
import { ROOT } from './repo';

export interface Token {
  readonly text: string;
  readonly scopes: readonly string[];
}

interface ManifestGrammar {
  readonly scopeName: string;
  readonly path: string;
  readonly injectTo?: string[];
  readonly embeddedLanguages?: Record<string, string>;
}

/** The grammars the extension contributes, as the manifest declares them. */
export function contributedGrammars(): ManifestGrammar[] {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    contributes: { grammars: ManifestGrammar[] };
  };
  return manifest.contributes.grammars;
}

interface Host {
  readonly lineComments: readonly string[];
  readonly blockComment: boolean;
  /** Plain `'` and `"` strings (one line). */
  readonly quotes: readonly string[];
  readonly template: boolean;
  readonly triple: readonly string[];
}

const HOSTS: Record<string, Host> = {
  'source.js': {
    lineComments: ['//'],
    blockComment: true,
    quotes: ['"', "'"],
    template: true,
    triple: [],
  },
  'source.js.jsx': {
    lineComments: ['//'],
    blockComment: true,
    quotes: ['"', "'"],
    template: true,
    triple: [],
  },
  'source.ts': {
    lineComments: ['//'],
    blockComment: true,
    quotes: ['"', "'"],
    template: true,
    triple: [],
  },
  'source.tsx': {
    lineComments: ['//'],
    blockComment: true,
    quotes: ['"', "'"],
    template: true,
    triple: [],
  },
  'source.python': {
    lineComments: ['#'],
    blockComment: false,
    quotes: ['"', "'"],
    template: false,
    triple: ['"""', "'''"],
  },
  'source.go': {
    lineComments: ['//'],
    blockComment: true,
    quotes: ['"'],
    template: true,
    triple: [],
  },
  'source.php': {
    lineComments: ['//', '#'],
    blockComment: true,
    quotes: ['"', "'"],
    template: false,
    triple: [],
  },
  'source.java': {
    lineComments: ['//'],
    blockComment: true,
    quotes: ['"'],
    template: false,
    triple: ['"""'],
  },
  'source.kotlin': {
    lineComments: ['//'],
    blockComment: true,
    quotes: ['"'],
    template: false,
    triple: ['"""'],
  },
  'source.cs': {
    lineComments: ['//'],
    blockComment: true,
    quotes: ['"'],
    template: false,
    triple: ['"""'],
  },
};

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** A host language reduced to what matters here: comments and strings, which win over code. */
function hostGrammar(scope: string, host: Host): IRawGrammar {
  const patterns: object[] = [];
  if (host.blockComment) {
    patterns.push({ begin: '/\\*', end: '\\*/', name: 'comment.block' });
  }
  for (const comment of host.lineComments) {
    patterns.push({ match: `${escapeRe(comment)}.*$`, name: 'comment.line' });
  }
  for (const quotes of host.triple) {
    patterns.push({
      begin: `(?<!\\w)[rRuUbBfF]{0,2}${escapeRe(quotes)}`,
      end: escapeRe(quotes),
      name: 'string.quoted.triple',
    });
  }
  for (const quote of host.quotes) {
    patterns.push({
      begin: escapeRe(quote),
      end: `${escapeRe(quote)}|$`,
      name: 'string.quoted',
      patterns: [{ match: '\\\\.' }],
    });
  }
  if (host.template) {
    patterns.push({
      begin: '`',
      end: '`',
      name: 'string.template',
      patterns: [{ match: '\\\\.' }],
    });
  }
  patterns.push({
    match: '\\b(?:const|let|var|def|func|return|echo|String|val|public)\\b',
    name: 'keyword.control',
  });
  return parseRawGrammar(JSON.stringify({ scopeName: scope, patterns }), `${scope}.json`);
}

/** Enough SQL to see that the embedded grammar took over. */
const SQL_GRAMMAR = {
  scopeName: 'source.sql',
  patterns: [
    { match: '--.*$', name: 'comment.line.double-dash.sql' },
    {
      match: '\\b(?:select|from|where|insert|into|values|update|set|join|and|order|by)\\b',
      name: 'keyword.other.sql',
      // The real grammar is case-insensitive.
    },
    {
      match: '\\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|JOIN|AND|ORDER|BY)\\b',
      name: 'keyword.other.sql',
    },
  ],
};

const SQL_SCOPE = 'meta.embedded.block.sql';

let onig: Promise<void> | undefined;

function loadEngine(): Promise<void> {
  const require = createRequire(import.meta.url);
  onig ??= loadWASM(readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer);
  return onig;
}

const cache = new Map<string, Promise<IGrammar>>();

/** The host language with every contributed injection that targets it, like the editor does. */
export function hostGrammarOf(scope: string): Promise<IGrammar> {
  let loaded = cache.get(scope);
  if (loaded === undefined) {
    loaded = (async () => {
      await loadEngine();
      const injections = contributedGrammars().filter((grammar) =>
        grammar.injectTo?.includes(scope),
      );
      const registry = new Registry({
        onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
        loadGrammar: (name) => {
          if (name === 'source.sql') {
            return Promise.resolve(parseRawGrammar(JSON.stringify(SQL_GRAMMAR), 'sql.json'));
          }
          const host = HOSTS[name];
          if (host !== undefined) {
            return Promise.resolve(hostGrammar(name, host));
          }
          const own = injections.find((grammar) => grammar.scopeName === name);
          if (own !== undefined) {
            const text = readFileSync(join(ROOT, own.path), 'utf8');
            return Promise.resolve(parseRawGrammar(text, own.path));
          }
          return Promise.resolve(null);
        },
        getInjections: (name) =>
          name === scope ? injections.map((grammar) => grammar.scopeName) : undefined,
      });
      const grammar = await registry.loadGrammar(scope);
      if (grammar === null) {
        throw new Error(`No grammar for ${scope}`);
      }
      return grammar;
    })();
    cache.set(scope, loaded);
  }
  return loaded;
}

/** The tokens of each line of `source`, with the scopes they carry. */
export async function tokenize(scope: string, source: string): Promise<Token[][]> {
  const grammar = await hostGrammarOf(scope);
  let state = INITIAL;
  return source.split('\n').map((line) => {
    const result = grammar.tokenizeLine(line, state);
    state = result.ruleStack;
    return result.tokens.map((token) => ({
      text: line.slice(token.startIndex, token.endIndex),
      scopes: token.scopes,
    }));
  });
}

/** The text that lies inside embedded SQL, line by line (lines without any are left out). */
export async function embeddedSql(scope: string, source: string): Promise<string[]> {
  const lines = await tokenize(scope, source);
  return lines
    .map((tokens) =>
      tokens
        .filter((token) => token.scopes.includes(SQL_SCOPE))
        .map((token) => token.text)
        .join(''),
    )
    .filter((text) => text !== '');
}

/** The SQL keywords the stand-in SQL grammar found, i.e. proof that SQL took over. */
export async function sqlKeywords(scope: string, source: string): Promise<string[]> {
  const lines = await tokenize(scope, source);
  return lines.flatMap((tokens) =>
    tokens.filter((token) => token.scopes.includes('keyword.other.sql')).map((token) => token.text),
  );
}
