// The words of the @datanest chat participant (V13.15): which connection a question is
// about, the prompts it sends the model, and the SQL it pulls out of an answer. Pure text,
// so it is tested without an editor or a model.

import { isReadOnlyStatement } from '../core/sql/read-only';
import { splitStatements } from '../core/sql/split';
import { syntaxOf } from '../core/sql/tokenizer';
import { type ConnectionConfig, isSqlDriver } from '../shared/connection';

/** The id of the participant in `package.json`. */
export const CHAT_PARTICIPANT_ID = 'datanest.chat';

export type ConnectionChoice =
  | { readonly kind: 'found'; readonly config: ConnectionConfig }
  | { readonly kind: 'choose'; readonly configs: readonly ConnectionConfig[] }
  | { readonly kind: 'none' };

/**
 * The connection a question is about: the one whose name it mentions (the longest
 * name wins, so "shop" does not hide "shop-staging"), else the only usable one.
 */
export function chooseConnection(
  text: string,
  configs: readonly ConnectionConfig[],
): ConnectionChoice {
  const usable = configs.filter((config) => isSqlDriver(config.driver) && config.disabled !== true);
  if (usable.length === 0) {
    return { kind: 'none' };
  }
  const lower = text.toLowerCase();
  const mentioned = usable
    .filter((config) => lower.includes(config.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length);
  const first = mentioned[0];
  if (first !== undefined) {
    return { kind: 'found', config: first };
  }
  const only = usable[0];
  return usable.length === 1 && only !== undefined
    ? { kind: 'found', config: only }
    : { kind: 'choose', configs: usable };
}

/** The first fenced code block of an answer, or the whole answer when it has none. */
export function extractSql(answer: string): string {
  const fenced = /```(?:sql|[a-z]*)?\s*\n([\s\S]*?)```/iu.exec(answer);
  return (fenced?.[1] ?? answer).trim();
}

/** True when the text is one statement that only reads: the only kind the chat runs. */
export function isRunnableByChat(sql: string, driver: ConnectionConfig['driver']): boolean {
  const statements = splitStatements(sql, driver);
  const only = statements[0];
  return (
    only !== undefined &&
    statements.length === 1 &&
    isReadOnlyStatement(only.text, syntaxOf(driver))
  );
}

export function queryPrompt(options: {
  readonly question: string;
  readonly driver: string;
  readonly digest: string;
}): string {
  return [
    `You write one SQL statement for ${options.driver}.`,
    'Answer with the statement in a single ```sql block and one short sentence after it.',
    'Use only tables and columns from the schema. Write a statement that only reads (SELECT).',
    'Add a LIMIT unless the question asks for everything.',
    '',
    'Schema:',
    options.digest === '' ? '(unknown: ask the user which tables to use)' : options.digest,
    '',
    `Question: ${options.question}`,
  ].join('\n');
}

export function explainPrompt(options: { readonly sql: string; readonly digest: string }): string {
  return [
    'Explain what this SQL statement does, step by step, in plain words for a developer.',
    'Say what it reads, how rows are matched and filtered, and what the result looks like.',
    'Point out anything slow or risky. Do not rewrite it unless asked.',
    '',
    options.digest === '' ? '' : `Schema:\n${options.digest}\n`,
    '```sql',
    options.sql,
    '```',
  ].join('\n');
}

/** The table of a query answer (the JSON of the tool) as Markdown for the chat. */
export function answerTable(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const { columns, rows, truncated } = parsed as {
    columns?: unknown;
    rows?: unknown;
    truncated?: unknown;
  };
  if (!Array.isArray(columns) || !Array.isArray(rows) || columns.length === 0) {
    return undefined;
  }
  const cell = (value: unknown): string =>
    (value === null ? 'NULL' : typeof value === 'string' ? value : JSON.stringify(value))
      .replaceAll('|', '\\|')
      .replaceAll(/\r?\n/gu, ' ');
  const header = `| ${columns.map(cell).join(' | ')} |`;
  const rule = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${(row as unknown[]).map(cell).join(' | ')} |`);
  return [header, rule, ...body, ...(truncated === true ? ['', '_…more rows exist._'] : [])].join(
    '\n',
  );
}
