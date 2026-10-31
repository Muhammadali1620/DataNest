import type { CodiconName } from '../../lib/codicons';

/**
 * Which icon a column header shows for the server's type name. The rules are checked in
 * order, because names overlap: `interval` and `point` contain "int", `timestamp`
 * contains "time", and an array of integers is an array first.
 */
const RULES: readonly (readonly [RegExp, CodiconName])[] = [
  [/^array\b|\[\]$|^_/, 'symbol-array'],
  [/json|bson|document|object|variant|map\(|tuple\(/, 'json'],
  [/geometry|geography|point|polygon|linestring|\bline\b|circle|box|path/, 'globe'],
  [/date|time|year|interval/, 'calendar'],
  [/bool/, 'symbol-boolean'],
  [/uuid|guid|uniqueidentifier|rowid|objectid/, 'symbol-key'],
  [/enum|\bset\b/, 'symbol-enum'],
  [/blob|binary|bytea|image|raw|bytes/, 'file-media'],
  [/int|serial|num|dec|real|float|double|money|bit/, 'symbol-numeric'],
  [/char|text|string|clob|name|xml|citext|inet|cidr|mac/, 'symbol-string'],
];

export function typeIcon(dataType: string | undefined): CodiconName {
  if (dataType === undefined) {
    return 'symbol-field';
  }
  const type = dataType.toLowerCase();
  return RULES.find(([pattern]) => pattern.test(type))?.[1] ?? 'symbol-field';
}
