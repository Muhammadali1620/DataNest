// The DataNest tools of the editor's language model (V13.15), registered with the
// stable `vscode.lm` API. All the rules live in `services/ai-tools.ts`; this file words
// the questions the user is asked, turns the model's input into calls, and does nothing
// at all in an editor whose build has no language model API.

import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import {
  AI_TOOL_NAMES,
  type AiConfirmation,
  type AiQueryInput,
  type AiScopeInput,
  type AiTableInput,
  type AiToolName,
  type AiToolResult,
  type AiTools,
} from '../services/ai-tools';

/** True where the editor offers `vscode.lm.registerTool` (some forks do not). */
export function hasLanguageModelTools(): boolean {
  const lm = (vscode as Partial<typeof vscode>).lm;
  return typeof lm?.registerTool === 'function';
}

function confirmationTexts(
  confirmation: AiConfirmation,
): vscode.LanguageModelToolConfirmationMessages {
  const message = new vscode.MarkdownString();
  if (confirmation.production) {
    message.appendMarkdown(
      `**${vscode.l10n.t('"{0}" is a production database.', confirmation.connection)}**\n\n`,
    );
  }
  if (confirmation.sql !== undefined) {
    message.appendMarkdown(
      `${vscode.l10n.t('The assistant wants to run this statement on "{0}". Only statements that read are run, at most 100 rows come back.', confirmation.connection)}\n\n`,
    );
    message.appendCodeblock(confirmation.sql, 'sql');
  } else {
    message.appendMarkdown(
      vscode.l10n.t('The assistant wants to read the structure of "{0}".', confirmation.connection),
    );
  }
  return {
    title:
      confirmation.sql === undefined
        ? vscode.l10n.t('Read the structure of a database')
        : vscode.l10n.t('Run a query'),
    message,
  };
}

function result(answer: AiToolResult): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(answer.text)]);
}

/** What a model may send; each tool reads the members it declares in `package.json`. */
interface ToolInput {
  connection?: string;
  sql?: string;
  table?: string;
  database?: string;
  schema?: string;
}

/** Registers the four tools; returns what to dispose (nothing where the editor has no such API). */
export function registerAiTools(tools: AiTools, logger: Logger): vscode.Disposable[] {
  if (!hasLanguageModelTools()) {
    logger.info('This editor has no language model tools API: DataNest tools are not offered');
    return [];
  }
  const register = (
    name: AiToolName,
    invokeTool: (input: ToolInput) => Promise<AiToolResult> | AiToolResult,
  ): vscode.Disposable =>
    vscode.lm.registerTool<ToolInput>(name, {
      invoke: async (options) => {
        try {
          return result(await invokeTool(options.input));
        } catch (error) {
          logger.warn(`Tool ${name} failed`, error);
          return result({
            text: `The tool failed: ${error instanceof Error ? error.message : String(error)}`,
            refused: true,
          });
        }
      },
      prepareInvocation: (options) => {
        const confirmation = tools.confirmationFor(name, options.input);
        return confirmation === undefined
          ? {}
          : { confirmationMessages: confirmationTexts(confirmation) };
      },
    });
  return [
    register(AI_TOOL_NAMES.listConnections, () => tools.listConnections()),
    register(AI_TOOL_NAMES.listTables, (input) => tools.listTables(input as AiScopeInput)),
    register(AI_TOOL_NAMES.describeTable, (input) => tools.describeTable(input as AiTableInput)),
    register(AI_TOOL_NAMES.runReadOnlyQuery, (input) =>
      tools.runReadOnlyQuery(input as AiQueryInput),
    ),
  ];
}
