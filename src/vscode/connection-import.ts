import { dirname, isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import type { ConnectionManager } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import {
  connectionsFromEnv,
  type EnvCandidate,
  isEnvFileName,
  parseDotenv,
  sameTarget,
} from '../services/env-import';
import { type ConnectionInput, describeTarget, isFileDriver } from '../shared/connection';
import { connectionInputSchema } from '../shared/connection-schema';
import { parseConnectionUrl, type UrlProblem } from '../shared/connection-url';
import { ConnectionFormPanel } from './panels/connection-form-panel';

export interface ConnectionImportDeps {
  readonly extensionUri: vscode.Uri;
  readonly store: ConnectionStore;
  readonly manager: ConnectionManager;
  readonly logger: Logger;
}

function urlProblemText(problem: UrlProblem): string {
  switch (problem) {
    case 'not-a-url':
      return vscode.l10n.t('This is not a connection URL, e.g. postgres://user@host:5432/db');
    case 'unknown-scheme':
      return vscode.l10n.t(
        'DataNest supports mysql://, mariadb://, postgres:// and sqlite:// URLs',
      );
    case 'no-host':
      return vscode.l10n.t('The URL names no host');
    case 'no-file':
      return vscode.l10n.t('The URL names no database file');
  }
}

/** A file path relative to `base`, as a .env file means it. */
function anchored(input: ConnectionInput, base: string | undefined): ConnectionInput {
  if (!isFileDriver(input.driver) || input.file === undefined || base === undefined) {
    return input;
  }
  return isAbsolute(input.file) ? input : { ...input, file: join(base, input.file) };
}

/**
 * Opens the connection form filled from a URL: the one given (from a link or another
 * extension), or one the user is asked for.
 */
export async function addConnectionFromUrl(
  deps: ConnectionImportDeps,
  given?: string,
): Promise<void> {
  const text = given ?? (await askForUrl());
  if (text === undefined || text.trim() === '') {
    return;
  }
  const parsed = parseConnectionUrl(text);
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(urlProblemText(parsed.problem));
    return;
  }
  const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const input = anchored(parsed.value.input, base);
  try {
    connectionInputSchema.parse(input);
  } catch (error) {
    deps.logger.warn('A connection URL did not fit the form', error);
    void vscode.window.showErrorMessage(vscode.l10n.t('A part of this URL is too long'));
    return;
  }
  ConnectionFormPanel.show(deps, undefined, {
    input,
    ...(parsed.value.password === undefined ? {} : { password: parsed.value.password }),
  });
}

async function askForUrl(): Promise<string | undefined> {
  return await vscode.window.showInputBox({
    title: vscode.l10n.t('Add Connection from URL'),
    prompt: vscode.l10n.t('The password in the URL is kept in the secret storage, not in settings'),
    placeHolder: 'postgres://user:password@host:5432/database?sslmode=require',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (value.trim() === '') {
        return undefined;
      }
      const parsed = parseConnectionUrl(value);
      return parsed.ok ? undefined : urlProblemText(parsed.problem);
    },
  });
}

interface FoundCandidate extends EnvCandidate {
  readonly file: vscode.Uri;
}

interface CandidateItem extends vscode.QuickPickItem {
  readonly candidate: FoundCandidate;
}

/** Reads every .env file of the workspace and adds the connections the user picks. */
export async function importConnectionsFromEnv(deps: ConnectionImportDeps): Promise<void> {
  const files = (await vscode.workspace.findFiles('**/.env*', '**/node_modules/**', 200)).filter(
    (uri) => isEnvFileName(uri.path.split('/').pop() ?? ''),
  );
  const found: FoundCandidate[] = [];
  for (const file of files) {
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
      for (const candidate of connectionsFromEnv(parseDotenv(text))) {
        const input = anchored(candidate.input, dirname(file.fsPath));
        try {
          connectionInputSchema.parse(input);
        } catch (error) {
          deps.logger.debug(`Skipped ${candidate.source} in ${file.fsPath}: ${String(error)}`);
          continue;
        }
        found.push({ ...candidate, input, file });
      }
    } catch (error) {
      deps.logger.warn(`Could not read ${file.fsPath}`, error);
    }
  }
  if (found.length === 0) {
    void vscode.window.showInformationMessage(
      files.length === 0
        ? vscode.l10n.t('There are no .env files in this workspace')
        : vscode.l10n.t('No database settings were found in the .env files'),
    );
    return;
  }
  const saved = deps.store.list();
  const items: CandidateItem[] = found.map((candidate) => {
    const known = saved.find((config) => sameTarget(config, candidate.input));
    return {
      label: candidate.input.name,
      description:
        known === undefined
          ? describeTarget(candidate.input)
          : vscode.l10n.t(
              '{0} — already saved as "{1}"',
              describeTarget(candidate.input),
              known.name,
            ),
      detail: `${vscode.workspace.asRelativePath(candidate.file)} · ${candidate.source}`,
      picked: known === undefined,
      candidate,
    };
  });
  const chosen = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Import Connections from .env'),
    placeHolder: vscode.l10n.t('Pick the connections to add; passwords go to the secret storage'),
    canPickMany: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (chosen === undefined || chosen.length === 0) {
    return;
  }
  for (const { candidate } of chosen) {
    await deps.store.add(candidate.input, candidate.password);
  }
  deps.logger.info(`Imported ${chosen.length} connection(s) from .env files`);
  void vscode.window.showInformationMessage(
    vscode.l10n.t('Added {0} connection(s) from .env files', chosen.length),
  );
}
