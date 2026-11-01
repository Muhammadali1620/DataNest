// The @datanest chat participant (V13.15): /schema shows the structure, /query writes a
// statement for a question and runs it when it only reads, /explain explains SQL. It
// talks to the model the user picked and reaches the databases only through `AiTools`,
// so it can never run anything those tools would refuse.

import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import {
  answerTable,
  CHAT_PARTICIPANT_ID,
  chooseConnection,
  explainPrompt,
  extractSql,
  isRunnableByChat,
  queryPrompt,
} from '../services/ai-chat';
import type { AiTools } from '../services/ai-tools';
import type { ConnectionConfig } from '../shared/connection';

/** True where the editor offers `vscode.chat.createChatParticipant`. */
export function hasChatParticipants(): boolean {
  const chat = (vscode as Partial<typeof vscode>).chat;
  return typeof chat?.createChatParticipant === 'function';
}

export interface ChatDeps {
  readonly tools: AiTools;
  readonly connections: () => ConnectionConfig[];
  readonly enabled: () => boolean;
  readonly logger: Logger;
}

async function ask(
  request: vscode.ChatRequest,
  prompt: string,
  token: vscode.CancellationToken,
): Promise<string> {
  const reply = await request.model.sendRequest(
    [vscode.LanguageModelChatMessage.User(prompt)],
    {},
    token,
  );
  let text = '';
  for await (const part of reply.text) {
    text += part;
  }
  return text;
}

export function registerChatParticipant(deps: ChatDeps): vscode.Disposable[] {
  if (!hasChatParticipants()) {
    return [];
  }
  const handler: vscode.ChatRequestHandler = async (request, _context, response, token) => {
    if (!deps.enabled()) {
      response.markdown(vscode.l10n.t('DataNest assistant tools are turned off in the settings.'));
      return;
    }
    try {
      const choice = chooseConnection(request.prompt, deps.connections());
      if (choice.kind === 'none') {
        response.markdown(
          vscode.l10n.t('There is no usable SQL connection yet. Add one in the DataNest view.'),
        );
        return;
      }
      if (choice.kind === 'choose' && request.command !== 'explain') {
        const names = choice.configs.map((config) => `- **${config.name}** (${config.driver})`);
        response.markdown(
          `${vscode.l10n.t('Which connection? Mention its name in your question:')}\n\n${names.join('\n')}`,
        );
        return;
      }
      const config = choice.kind === 'found' ? choice.config : undefined;
      const digest =
        config === undefined ? '' : await deps.tools.schemaDigest({ connection: config.id });

      if (request.command === 'schema') {
        response.markdown(
          digest === ''
            ? vscode.l10n.t(
                'The structure of "{0}" needs a database or schema: open it in the DataNest view first.',
                config?.name ?? '',
              )
            : `**${config?.name ?? ''}**\n\n\`\`\`\n${digest}\n\`\`\``,
        );
        return;
      }

      if (request.command === 'explain') {
        const sql = extractSql(request.prompt);
        response.progress(vscode.l10n.t('Explaining…'));
        response.markdown(await ask(request, explainPrompt({ sql, digest }), token));
        return;
      }

      // /query, and a question without a command, both write a statement.
      if (config === undefined) {
        return;
      }
      response.progress(vscode.l10n.t('Writing the statement…'));
      const answer = await ask(
        request,
        queryPrompt({ question: request.prompt, driver: config.driver, digest }),
        token,
      );
      const sql = extractSql(answer);
      response.markdown(answer);
      if (!isRunnableByChat(sql, config.driver)) {
        response.markdown(
          `\n\n${vscode.l10n.t('This statement is not run: only statements that merely read are.')}`,
        );
        return;
      }
      if (config.production === true) {
        response.markdown(
          `\n\n${vscode.l10n.t('"{0}" is a production database: the statement is not run for you.', config.name)}`,
        );
        return;
      }
      response.progress(vscode.l10n.t('Running it (read only, at most 100 rows)…'));
      const outcome = await deps.tools.runReadOnlyQuery({ connection: config.id, sql });
      const table = outcome.refused === true ? undefined : answerTable(outcome.text);
      response.markdown(`\n\n${table ?? outcome.text}`);
    } catch (error) {
      deps.logger.warn('The chat participant failed', error);
      response.markdown(
        vscode.l10n.t(
          'Something went wrong: {0}',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  };
  return [vscode.chat.createChatParticipant(CHAT_PARTICIPANT_ID, handler)];
}
