import * as vscode from 'vscode';
import { parseLogLevel, SinkLogger } from '../core/logging/logger';
import { CONFIG_KEYS, CONFIG_SECTION } from './command-ids';

/** The DataNest output channel plus a logger that follows the `datanest.logLevel` setting. */
export function createOutputLogger(): {
  readonly logger: SinkLogger;
  readonly channel: vscode.OutputChannel;
  readonly disposables: vscode.Disposable[];
} {
  const channel = vscode.window.createOutputChannel('DataNest');
  const logger = new SinkLogger({ sink: channel, level: readLogLevel() });
  const watcher = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_KEYS.logLevel}`)) {
      logger.setLevel(readLogLevel());
      logger.info(`Log level: ${logger.level}`);
    }
  });
  return { logger, channel, disposables: [channel, watcher] };
}

function readLogLevel(): ReturnType<typeof parseLogLevel> {
  return parseLogLevel(vscode.workspace.getConfiguration(CONFIG_SECTION).get(CONFIG_KEYS.logLevel));
}
