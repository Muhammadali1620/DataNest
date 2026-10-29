// Pieces of a dump script (V5.2) that need no server: how one statement is written,
// in which order views can be created, how rows become INSERT statements.

import { splitStatements } from '../core/sql/split';
import { syntaxOf, textOf, tokenize } from '../core/sql/tokenizer';
import type { DriverId } from '../shared/connection';

/** Used around MySQL bodies, as in an object's definition document (D41). */
export const BODY_DELIMITER = '//';

/**
 * One statement as script text. A MySQL routine or trigger has semicolons in its
 * body, so it is wrapped in DELIMITER lines, as the mysql client expects.
 */
export function scriptStatement(sql: string, driver: DriverId): string {
  const text = sql.trim();
  if (driver === 'mysql' && splitStatements(text, driver).length > 1) {
    return `DELIMITER ${BODY_DELIMITER}\n${text}${BODY_DELIMITER}\nDELIMITER ;\n`;
  }
  return `${text};\n`;
}

/** A line of comment text; line breaks in names cannot end the comment early. */
export function commentLine(text: string): string {
  return `-- ${text.replace(/[\r\n]+/gu, ' ')}\n`;
}

/**
 * Names the SQL mentions, unquoted: words and quoted identifiers. Strings and
 * comments are skipped, so a view whose text merely says "orders" in a string does
 * not count as using a view named orders.
 */
export function mentionedNames(sql: string, driver: DriverId | undefined): Set<string> {
  const names = new Set<string>();
  for (const token of tokenize(sql, syntaxOf(driver))) {
    if (token.kind === 'word') {
      names.add(textOf(sql, token).toLowerCase());
    } else if (token.kind === 'quoted-identifier') {
      const raw = textOf(sql, token);
      const quote = raw[0] ?? '';
      names.add(
        raw
          .slice(1, -1)
          .replaceAll(quote + quote, quote)
          .toLowerCase(),
      );
    }
  }
  return names;
}

/**
 * Views in an order they can be created in: a view that mentions another one comes
 * after it. A cycle cannot be ordered, so its members keep their given order.
 */
export function orderViews<T extends { readonly name: string; readonly sql: string }>(
  views: readonly T[],
  driver: DriverId,
): T[] {
  const byName = new Map(views.map((view) => [view.name.toLowerCase(), view]));
  const needs = new Map(
    views.map((view) => {
      const mentioned = mentionedNames(view.sql, driver);
      mentioned.delete(view.name.toLowerCase());
      return [view, [...mentioned].flatMap((name) => byName.get(name) ?? [])];
    }),
  );
  const ordered: T[] = [];
  const placed = new Set<T>();
  const visiting = new Set<T>();
  const place = (view: T): void => {
    if (placed.has(view) || visiting.has(view)) {
      return;
    }
    visiting.add(view);
    for (const needed of needs.get(view) ?? []) {
      place(needed);
    }
    visiting.delete(view);
    placed.add(view);
    ordered.push(view);
  };
  for (const view of views) {
    place(view);
  }
  return ordered;
}

/** At most this many rows go into one INSERT… */
export const INSERT_ROWS = 100;
/** …and at most about this many characters, so a server's packet limit is never near. */
export const INSERT_CHARS = 256 * 1024;

/** Collects `(…)` row lists and hands them out as INSERT-sized groups. */
export class RowBatcher {
  private rows: string[] = [];
  private chars = 0;

  /** Adds a row; returns a full group when this row completed one. */
  add(tuple: string): string[] | undefined {
    this.rows.push(tuple);
    this.chars += tuple.length;
    return this.rows.length >= INSERT_ROWS || this.chars >= INSERT_CHARS ? this.take() : undefined;
  }

  /** Whatever is left, possibly nothing. */
  take(): string[] {
    const rows = this.rows;
    this.rows = [];
    this.chars = 0;
    return rows;
  }
}
