import { describe, expect, it } from 'vitest';
import {
  BUG_TEMPLATE,
  bugReportUrl,
  NEW_ISSUE_URL,
  type ReportEnvironment,
  reportFields,
} from '../../../src/services/issue-report';

const ENV: ReportEnvironment = {
  extensionVersion: '0.9.0',
  editorName: 'Visual Studio Code',
  editorVersion: '1.105.0',
  platform: 'linux',
  arch: 'x64',
  osRelease: '7.0.0-38-generic',
  language: 'ru',
};

describe('reportFields', () => {
  it('names the versions that matter, in words a person reads', () => {
    expect(reportFields(ENV)).toEqual({
      version: '0.9.0',
      editor: 'Visual Studio Code 1.105.0',
      os: 'Linux 7.0.0-38-generic (x64)',
      language: 'ru',
    });
  });

  it('names Windows and macOS, and passes an unknown platform on as it is', () => {
    expect(reportFields({ ...ENV, platform: 'win32', osRelease: '10.0.26100' }).os).toBe(
      'Windows 10.0.26100 (x64)',
    );
    expect(reportFields({ ...ENV, platform: 'darwin', arch: 'arm64' }).os).toContain('macOS');
    expect(reportFields({ ...ENV, platform: 'freebsd' }).os).toContain('freebsd');
  });

  it('cuts long values and folds line breaks', () => {
    const fields = reportFields({ ...ENV, editorName: `Fork\n${'x'.repeat(500)}` });
    expect(fields.editor).toHaveLength(120);
    expect(fields.editor.endsWith('…')).toBe(true);
    expect(fields.editor).not.toContain('\n');
  });
});

describe('bugReportUrl', () => {
  it('opens the bug form of the repository with the fields filled', () => {
    const url = new URL(bugReportUrl(ENV));
    expect(`${url.origin}${url.pathname}`).toBe(NEW_ISSUE_URL);
    expect(url.searchParams.get('template')).toBe(BUG_TEMPLATE);
    expect(url.searchParams.get('version')).toBe('0.9.0');
    expect(url.searchParams.get('editor')).toBe('Visual Studio Code 1.105.0');
    expect(url.searchParams.get('os')).toBe('Linux 7.0.0-38-generic (x64)');
    expect(url.searchParams.get('language')).toBe('ru');
  });

  it('encodes what would break a link', () => {
    const url = bugReportUrl({ ...ENV, editorName: 'Cursor & Co #1?' });
    expect(new URL(url).searchParams.get('editor')).toBe('Cursor & Co #1? 1.105.0');
    expect(url).not.toContain(' ');
  });

  it('carries nothing but the environment', () => {
    const keys = [...new URL(bugReportUrl(ENV)).searchParams.keys()];
    expect(keys.sort()).toEqual(['editor', 'language', 'os', 'template', 'version']);
  });
});
