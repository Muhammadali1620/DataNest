// An Excel workbook with one sheet, written as plain XML inside a ZIP. Strings are
// stored inline (no shared-string table), which Excel, LibreOffice, Numbers and
// Google Sheets all read; what matters is that values keep their meaning:
// numbers a double can hold become numbers, everything else stays text so a
// 20-digit id or a "0042" code is never rounded or stripped.

import { retainedBytes } from '../shared/binary-bytes';
import { cellText } from '../shared/cell-text';
import { type CellValue, isTaggedValue } from '../shared/cell-value';
import { zip } from './zip';

/** Hard limits of the format. */
export const XLSX_MAX_ROWS = 1_048_576;
export const XLSX_MAX_COLUMNS = 16_384;
/** Longest text one cell holds. */
export const XLSX_MAX_CELL_CHARS = 32_767;

export interface XlsxInput {
  readonly sheetName?: string;
  readonly header: readonly string[];
  readonly rows: readonly (readonly CellValue[])[];
}

export class XlsxLimitError extends Error {
  override readonly name = 'XlsxLimitError';
}

/** `A`, `B`, … `Z`, `AA`, … for a 0-based column index. */
export function columnLetters(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Escapes text for XML and drops the characters XML 1.0 cannot hold at all. */
export function xmlText(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
  );
}

/** Sheet names may not contain `: \ / ? * [ ]`, are at most 31 characters, and are never empty. */
export function sheetNameOf(name: string | undefined): string {
  const cleaned = (name ?? 'Result')
    .replace(/[:\\/?*[\]]/g, ' ')
    .trim()
    .slice(0, 31);
  return cleaned === '' ? 'Result' : cleaned;
}

/** Digits a double keeps exactly. */
const SAFE_DIGITS = 15;

function isExactNumber(text: string): boolean {
  // No leading zeros: "0042" is a code, not 42, and must stay as typed.
  if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text)) {
    return false;
  }
  return text.replace(/[-.]/g, '').length <= SAFE_DIGITS;
}

function clip(text: string): string {
  return text.length <= XLSX_MAX_CELL_CHARS ? text : `${text.slice(0, XLSX_MAX_CELL_CHARS - 1)}…`;
}

function textCell(reference: string, text: string, style = ''): string {
  const value = xmlText(clip(text));
  const preserve = /^\s|\s$|\n/.test(value) ? ' xml:space="preserve"' : '';
  return `<c r="${reference}" t="inlineStr"${style}><is><t${preserve}>${value}</t></is></c>`;
}

function cellXml(reference: string, value: CellValue): string {
  if (value === null) {
    return '';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? `<c r="${reference}"><v>${value}</v></c>` : '';
  }
  if (typeof value === 'boolean') {
    return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  if (typeof value === 'string') {
    return textCell(reference, value);
  }
  if (isTaggedValue(value)) {
    if ((value.kind === 'bigint' || value.kind === 'decimal') && isExactNumber(value.text)) {
      return `<c r="${reference}"><v>${value.text}</v></c>`;
    }
    if (value.kind === 'binary') {
      const bytes = retainedBytes(value);
      const hex =
        bytes === undefined
          ? cellText(value)
          : `0x${Buffer.from(bytes.subarray(0, XLSX_MAX_CELL_CHARS / 2)).toString('hex')}`;
      return textCell(reference, hex);
    }
  }
  return textCell(reference, cellText(value));
}

/** Column width in characters from the header and the first rows, within sane bounds. */
function widthsOf(input: XlsxInput): number[] {
  return input.header.map((name, column) => {
    let longest = name.length;
    for (const row of input.rows.slice(0, 200)) {
      const cell = row[column];
      if (cell !== undefined && cell !== null) {
        longest = Math.max(longest, cellText(cell).split('\n')[0]?.length ?? 0);
      }
    }
    return Math.min(60, Math.max(8, longest + 2));
  });
}

function sheetXml(input: XlsxInput): string {
  const lastColumn = columnLetters(Math.max(0, input.header.length - 1));
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<dimension ref="A1:${lastColumn}${input.rows.length + 1}"/>`,
    // The header row stays in view while the data scrolls.
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
    '<sheetFormatPr defaultRowHeight="15"/>',
    `<cols>${widthsOf(input)
      .map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`)
      .join('')}</cols>`,
    '<sheetData>',
    `<row r="1">${input.header
      .map((name, column) => textCell(`${columnLetters(column)}1`, name, ' s="1"'))
      .join('')}</row>`,
  ];
  input.rows.forEach((row, index) => {
    const number = index + 2;
    const cells = input.header
      .map((_, column) => cellXml(`${columnLetters(column)}${number}`, row[column] ?? null))
      .join('');
    parts.push(`<row r="${number}">${cells}</row>`);
  });
  parts.push('</sheetData></worksheet>');
  return parts.join('');
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

/** The bytes of an .xlsx file; throws XlsxLimitError when the data does not fit the format. */
export function toXlsx(input: XlsxInput): Uint8Array {
  if (input.rows.length + 1 > XLSX_MAX_ROWS) {
    throw new XlsxLimitError(`Excel holds at most ${XLSX_MAX_ROWS - 1} data rows`);
  }
  if (input.header.length > XLSX_MAX_COLUMNS) {
    throw new XlsxLimitError(`Excel holds at most ${XLSX_MAX_COLUMNS} columns`);
  }
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlText(sheetNameOf(input.sheetName))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const text = (value: string): Uint8Array => Buffer.from(value, 'utf8');
  return zip([
    { name: '[Content_Types].xml', data: text(CONTENT_TYPES) },
    { name: '_rels/.rels', data: text(ROOT_RELS) },
    { name: 'xl/workbook.xml', data: text(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: text(WORKBOOK_RELS) },
    { name: 'xl/styles.xml', data: text(STYLES) },
    { name: 'xl/worksheets/sheet1.xml', data: text(sheetXml(input)) },
  ]);
}
