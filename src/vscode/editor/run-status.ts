import * as vscode from 'vscode';
import type { QueryRunner } from '../../services/query-runner';
import { COMMAND_IDS, CONTEXT_KEYS } from '../command-ids';
import { runStatusView, type RunStatusTexts } from './run-status-text';

/** How often the elapsed time is redrawn; often enough to look live, rarely enough to be cheap. */
export const TICK_MS = 200;

function texts(): RunStatusTexts {
  return {
    running: vscode.l10n.t('$(sync~spin) Running… {0}'),
    tooltip: vscode.l10n.t('DataNest: click to cancel the running query'),
  };
}

/**
 * A status bar item that counts up while a query runs and cancels it on click.
 * It also keeps the `datanest.queryRunning` context key, which shows the Cancel
 * button in the editor title.
 */
export class RunStatus implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly runner: QueryRunner;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(runner: QueryRunner) {
    this.runner = runner;
    // To the left of the connection item, so the two never swap places.
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    this.item.command = COMMAND_IDS.cancelQuery;
    this.subscriptions.push(
      this.item,
      runner.onDidChangeRunning(() => {
        this.update();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.update();
      }),
    );
    this.update();
  }

  dispose(): void {
    this.stopTimer();
    for (const subscription of this.subscriptions.reverse()) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
  }

  private update(): void {
    const documentUri = vscode.window.activeTextEditor?.document.uri.toString();
    const startedAt = documentUri === undefined ? undefined : this.runner.startedAt(documentUri);
    if (startedAt === undefined) {
      this.hide();
      return;
    }
    this.draw(startedAt);
    this.startTimer(documentUri);
  }

  private draw(startedAt: number): void {
    const view = runStatusView(Date.now() - startedAt, texts());
    this.item.text = view.text;
    this.item.tooltip = view.tooltip;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.item.show();
    void this.setRunningContext(true);
  }

  private hide(): void {
    this.stopTimer();
    this.item.hide();
    void this.setRunningContext(false);
  }

  private startTimer(documentUri: string | undefined): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      const startedAt = documentUri === undefined ? undefined : this.runner.startedAt(documentUri);
      if (startedAt === undefined) {
        this.hide();
        return;
      }
      this.draw(startedAt);
    }, TICK_MS);
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** The context key drives the Cancel button; it is only set when it changes. */
  private async setRunningContext(running: boolean): Promise<void> {
    if (this.running === running) {
      return;
    }
    this.running = running;
    await vscode.commands.executeCommand('setContext', CONTEXT_KEYS.queryRunning, running);
  }
}
