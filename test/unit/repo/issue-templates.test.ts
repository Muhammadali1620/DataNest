// The issue forms (V9.6) the bug report link opens: they must exist, parse, ask what a
// report needs, and have a field for every value the link fills in.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  BUG_TEMPLATE,
  NEW_ISSUE_URL,
  type ReportFields,
  reportFields,
} from '../../../src/services/issue-report';
import { readJson, ROOT } from '../../helpers/repo';

interface FormField {
  type: string;
  id?: string;
  validations?: { required?: boolean };
}

interface IssueForm {
  name: string;
  description: string;
  labels?: string[];
  body: FormField[];
}

function form(name: string): IssueForm {
  return parse(readFileSync(join(ROOT, '.github', 'ISSUE_TEMPLATE', name), 'utf8')) as IssueForm;
}

describe('.github/ISSUE_TEMPLATE', () => {
  it('has a bug form that the report link points at', () => {
    const bug = form(BUG_TEMPLATE);
    expect(bug.name).toBe('Bug report');
    expect(bug.labels).toEqual(['bug']);
  });

  it('has a field for every value the link fills in', () => {
    const ids = form(BUG_TEMPLATE).body.flatMap((field) =>
      field.id === undefined ? [] : [field.id],
    );
    const filled = Object.keys(
      reportFields({
        extensionVersion: '1',
        editorName: 'e',
        editorVersion: '1',
        platform: 'linux',
        arch: 'x64',
        osRelease: '1',
        language: 'en',
      }),
    ) as (keyof ReportFields)[];
    expect(ids).toEqual(expect.arrayContaining(filled));
  });

  it('asks for what a report cannot do without', () => {
    const required = form(BUG_TEMPLATE)
      .body.filter((field) => field.validations?.required === true)
      .map((field) => field.id);
    expect(required).toEqual(['what', 'steps', 'database', 'version', 'editor']);
  });

  it('has a feature form and points blank issues at the documentation', () => {
    expect(form('feature_request.yml').labels).toEqual(['enhancement']);
    const config = parse(
      readFileSync(join(ROOT, '.github', 'ISSUE_TEMPLATE', 'config.yml'), 'utf8'),
    ) as { contact_links: { url: string }[] };
    expect(config.contact_links[0]?.url).toContain('docs/index.md');
  });

  it('opens issues in the repository the manifest names', () => {
    const { bugs } = readJson('package.json') as { bugs: { url: string } };
    expect(NEW_ISSUE_URL).toBe(`${bugs.url}/new`);
  });
});
