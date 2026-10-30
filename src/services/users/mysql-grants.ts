// Reading `SHOW GRANTS` of MySQL, MariaDB and TiDB (V8.6) into privileges by target.
// Each line is a GRANT statement; whatever follows the account (MariaDB prints the
// password hash there) is never kept, only WITH GRANT / ADMIN OPTION is looked for.

import type { DbGrant } from './user-admin';

type Token =
  | { readonly kind: 'name'; readonly text: string }
  | { readonly kind: 'word'; readonly text: string }
  | { readonly kind: 'mark'; readonly text: string };

function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < line.length) {
    const char = line.charAt(at);
    if (/\s/u.test(char)) {
      at += 1;
    } else if (char === '`' || char === "'" || char === '"') {
      // Quoted names double their quote inside.
      let text = '';
      at += 1;
      while (at < line.length) {
        if (line.charAt(at) === char) {
          if (line.charAt(at + 1) === char) {
            text += char;
            at += 2;
            continue;
          }
          break;
        }
        text += line.charAt(at);
        at += 1;
      }
      at += 1;
      tokens.push({ kind: 'name', text });
    } else if (/[\w$]/u.test(char)) {
      const match = /^[\w$]+/u.exec(line.slice(at));
      const text = match?.[0] ?? char;
      tokens.push({ kind: 'word', text });
      at += text.length;
    } else {
      tokens.push({ kind: 'mark', text: char });
      at += 1;
    }
  }
  return tokens;
}

const isWord = (token: Token | undefined, word: string): boolean =>
  token?.kind === 'word' && token.text.toUpperCase() === word;

/** The privileges of one `SHOW GRANTS` line; nothing for lines it does not understand. */
export function readGrantLine(line: string): DbGrant[] {
  const tokens = tokenize(line);
  if (!isWord(tokens[0], 'GRANT')) {
    return [];
  }
  const on = tokens.findIndex((token) => isWord(token, 'ON'));
  const to = tokens.findIndex((token) => isWord(token, 'TO'));
  if (to < 0) {
    return [];
  }
  const rest = tokens.slice(to + 1);
  const withOption = (option: string): boolean =>
    rest.some(
      (token, index) =>
        isWord(token, 'WITH') &&
        isWord(rest[index + 1], option) &&
        isWord(rest[index + 2], 'OPTION'),
    );
  if (on < 0 || on > to) {
    return roleGrants(tokens.slice(1, to), withOption('ADMIN'));
  }
  const target = readTarget(tokens.slice(on + 1, to));
  if (target === undefined) {
    return [];
  }
  const grants: DbGrant[] = [];
  for (const privilege of privileges(tokens.slice(1, on))) {
    if (privilege.name === 'USAGE') {
      continue;
    }
    const fixed = privilege.columns !== undefined || target.fixed;
    grants.push({
      ...target.where,
      privilege:
        privilege.columns === undefined
          ? privilege.name
          : `${privilege.name} (${privilege.columns.join(', ')})`,
      grantable: false,
      ...(fixed ? { fixed: true } : {}),
    });
  }
  if (withOption('GRANT')) {
    grants.push({
      ...target.where,
      privilege: 'GRANT OPTION',
      grantable: false,
      ...(target.fixed ? { fixed: true } : {}),
    });
  }
  return grants;
}

/** `GRANT \`reader\`@\`%\`, \`writer\` TO …`: the roles granted to the account. */
function roleGrants(tokens: readonly Token[], admin: boolean): DbGrant[] {
  const grants: DbGrant[] = [];
  for (const part of split(tokens)) {
    const name = part[0];
    if (name === undefined || name.kind === 'mark') {
      continue;
    }
    const host = part[1]?.text === '@' ? part[2]?.text : undefined;
    grants.push({
      level: 'role',
      name: name.text,
      ...(host === undefined ? {} : { host }),
      privilege: 'ROLE',
      grantable: admin,
    });
  }
  return grants;
}

interface Privilege {
  readonly name: string;
  readonly columns?: readonly string[];
}

/** `SELECT (\`a\`, \`b\`), CREATE TEMPORARY TABLES, AUDIT_ADMIN`. */
function privileges(tokens: readonly Token[]): Privilege[] {
  const result: Privilege[] = [];
  let words: string[] = [];
  let columns: string[] | undefined;
  let inColumns = false;
  const flush = (): void => {
    if (words.length > 0) {
      result.push({
        name: words.join(' ').toUpperCase(),
        ...(columns === undefined ? {} : { columns }),
      });
    }
    words = [];
    columns = undefined;
  };
  for (const token of tokens) {
    if (inColumns) {
      if (token.text === ')' && token.kind === 'mark') {
        inColumns = false;
      } else if (token.kind !== 'mark') {
        columns?.push(token.text);
      }
    } else if (token.kind === 'mark' && token.text === '(') {
      inColumns = true;
      columns = [];
    } else if (token.kind === 'mark' && token.text === ',') {
      flush();
    } else if (token.kind !== 'mark') {
      words.push(token.text);
    }
  }
  flush();
  return result;
}

interface Target {
  readonly where: Pick<DbGrant, 'level' | 'database' | 'name'>;
  /** A target a REVOKE from here does not rebuild (a routine, a proxy). */
  readonly fixed: boolean;
}

function readTarget(tokens: readonly Token[]): Target | undefined {
  let rest = tokens;
  let routine = false;
  const kind = rest[0];
  if (isWord(kind, 'TABLE')) {
    rest = rest.slice(1);
  } else if (isWord(kind, 'FUNCTION') || isWord(kind, 'PROCEDURE')) {
    rest = rest.slice(1);
    routine = true;
  }
  const [first, dot, second] = rest;
  if (first === undefined) {
    return undefined;
  }
  // PROXY ON ''@'': the target is an account, not an object.
  if (rest[1]?.text === '@') {
    return { where: { level: 'server' }, fixed: true };
  }
  if (dot?.text !== '.' || second === undefined) {
    return first.text === '*' ? { where: { level: 'server' }, fixed: true } : undefined;
  }
  if (first.text === '*' && second.text === '*' && first.kind === 'mark') {
    return { where: { level: 'server' }, fixed: false };
  }
  if (second.kind === 'mark' && second.text === '*') {
    return { where: { level: 'database', database: first.text }, fixed: false };
  }
  return {
    where: { level: routine ? 'routine' : 'table', database: first.text, name: second.text },
    fixed: routine,
  };
}

/** Parts of a list between top-level commas. */
function split(tokens: readonly Token[]): Token[][] {
  const parts: Token[][] = [[]];
  for (const token of tokens) {
    if (token.kind === 'mark' && token.text === ',') {
      parts.push([]);
    } else {
      parts.at(-1)?.push(token);
    }
  }
  return parts.filter((part) => part.length > 0);
}
