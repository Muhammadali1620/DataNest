// What a bug report starts with (V9.6): the versions that matter, filled into the issue
// form on GitHub, so nobody has to look them up. Nothing about connections, servers or
// queries goes in: what to share beyond the versions is the reporter's choice.

/** The new-issue page of the repository; package.json `bugs.url` plus `/new`. */
export const NEW_ISSUE_URL = 'https://github.com/Muhammadali1620/DataNest/issues/new';

/** The issue form in .github/ISSUE_TEMPLATE whose fields the link fills. */
export const BUG_TEMPLATE = 'bug_report.yml';

export interface ReportEnvironment {
  readonly extensionVersion: string;
  /** The editor's own name: Visual Studio Code, VSCodium, Cursor, … */
  readonly editorName: string;
  readonly editorVersion: string;
  /** `process.platform`. */
  readonly platform: string;
  readonly arch: string;
  readonly osRelease: string;
  /** The display language, e.g. `ru`. */
  readonly language: string;
}

/** Longer values are cut, so a strange environment cannot make the link unusable. */
const MAX_VALUE = 120;

const PLATFORMS: Readonly<Record<string, string>> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

function short(value: string): string {
  const clean = value.replace(/[\r\n]+/gu, ' ').trim();
  return clean.length <= MAX_VALUE ? clean : `${clean.slice(0, MAX_VALUE - 1)}…`;
}

/** The fields of the bug form the link fills, named by their ids in the form. */
export interface ReportFields {
  readonly version: string;
  readonly editor: string;
  readonly os: string;
  readonly language: string;
}

export function reportFields(env: ReportEnvironment): ReportFields {
  const platform = PLATFORMS[env.platform] ?? env.platform;
  return {
    version: short(env.extensionVersion),
    editor: short(`${env.editorName} ${env.editorVersion}`),
    os: short(`${platform} ${env.osRelease} (${env.arch})`),
    language: short(env.language),
  };
}

/** A link that opens the bug form with the environment filled in. */
export function bugReportUrl(env: ReportEnvironment, base: string = NEW_ISSUE_URL): string {
  const query = new URLSearchParams({ template: BUG_TEMPLATE, ...reportFields(env) });
  return `${base}?${query.toString()}`;
}
