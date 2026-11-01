import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (
  request: unknown,
  context: unknown,
  response: unknown,
  token: unknown,
) => Promise<void>;

const created: { id: string; handler: Handler }[] = [];
const hosted = { chat: true };

vi.mock('vscode', () => ({
  l10n: {
    t: (text: string, ...args: unknown[]) =>
      text.replace(/\{(\d+)\}/g, (_m, i: string) => String(args[Number(i)])),
  },
  LanguageModelChatMessage: { User: (content: string) => ({ content }) },
  get chat() {
    return hosted.chat
      ? {
          createChatParticipant: (id: string, handler: Handler) => {
            created.push({ id, handler });
            return { dispose: () => undefined };
          },
        }
      : undefined;
  },
}));

import type { AiTools } from '../../../src/services/ai-tools';
import type { ConnectionConfig } from '../../../src/shared/connection';
import { CHAT_PARTICIPANT_ID } from '../../../src/services/ai-chat';
import { hasChatParticipants, registerChatParticipant } from '../../../src/vscode/ai-chat';
import { RecordingLogger } from '../../helpers/fakes';

const shop: ConnectionConfig = { id: 'a', name: 'shop', driver: 'mysql' };
const prod: ConnectionConfig = { id: 'p', name: 'live', driver: 'postgres', production: true };

function setup(configs: ConnectionConfig[], answer = '```sql\nSELECT 1\n```\nDone.') {
  const tools = {
    schemaDigest: vi.fn(() => Promise.resolve('orders(id int pk)')),
    runReadOnlyQuery: vi.fn(() =>
      Promise.resolve({ text: JSON.stringify({ columns: ['n'], rows: [[1]], rowCount: 1 }) }),
    ),
  };
  const logger = new RecordingLogger();
  let enabled = true;
  registerChatParticipant({
    tools: tools as unknown as AiTools,
    connections: () => configs,
    enabled: () => enabled,
    logger,
  });
  const sent: string[] = [];
  const request = (prompt: string, command?: string) => ({
    prompt,
    command,
    model: {
      sendRequest: (messages: { content: string }[]) => {
        sent.push(messages[0]?.content ?? '');
        return Promise.resolve({
          text: (async function* () {
            await Promise.resolve();
            yield answer.slice(0, 5);
            yield answer.slice(5);
          })(),
        });
      },
    },
  });
  const output: string[] = [];
  const response = {
    markdown: (text: string) => output.push(text),
    progress: (text: string) => output.push(`~${text}`),
  };
  const run = async (prompt: string, command?: string) => {
    await created.at(-1)?.handler(request(prompt, command), {}, response, {});
    return output.join('');
  };
  return {
    tools,
    run,
    sent,
    logger,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
  };
}

beforeEach(() => {
  created.length = 0;
  hosted.chat = true;
});

describe('registerChatParticipant', () => {
  it('registers the participant of the manifest', () => {
    setup([shop]);
    expect(created.map((entry) => entry.id)).toEqual([CHAT_PARTICIPANT_ID]);
    expect(CHAT_PARTICIPANT_ID).toBe('datanest.chat');
  });

  it('does nothing in an editor without chat participants', () => {
    hosted.chat = false;
    expect(hasChatParticipants()).toBe(false);
    expect(
      registerChatParticipant({
        tools: {} as AiTools,
        connections: () => [],
        enabled: () => true,
        logger: new RecordingLogger(),
      }),
    ).toEqual([]);
    expect(created).toEqual([]);
  });
});

describe('the participant', () => {
  it('writes a statement for a question and runs it when it only reads', async () => {
    const { run, tools, sent } = setup([shop]);
    const out = await run('how many orders?');
    expect(sent[0]).toContain('how many orders?');
    expect(sent[0]).toContain('orders(id int pk)');
    expect(tools.runReadOnlyQuery).toHaveBeenCalledWith({ connection: 'a', sql: 'SELECT 1' });
    expect(out).toContain('SELECT 1');
    expect(out).toContain('| n |');
    expect(out).toContain('| 1 |');
  });

  it('shows a statement that changes data and does not run it', async () => {
    const { run, tools } = setup([shop], '```sql\nDELETE FROM orders\n```');
    const out = await run('clean up', 'query');
    expect(tools.runReadOnlyQuery).not.toHaveBeenCalled();
    expect(out).toContain('DELETE FROM orders');
    expect(out).toContain('not run');
  });

  it('does not run anything for the user on a production connection', async () => {
    const { run, tools } = setup([prod]);
    const out = await run('count rows');
    expect(tools.runReadOnlyQuery).not.toHaveBeenCalled();
    expect(out).toContain('"live" is a production database');
  });

  it('shows the refusal of the tool as text', async () => {
    const { run, tools } = setup([shop]);
    tools.runReadOnlyQuery.mockResolvedValueOnce({ text: 'Refused: …', refused: true } as never);
    expect(await run('q')).toContain('Refused: …');
  });

  it('asks which connection when several fit', async () => {
    const { run, tools } = setup([shop, prod]);
    const out = await run('count rows');
    expect(out).toContain('Which connection?');
    expect(out).toContain('**shop**');
    expect(tools.runReadOnlyQuery).not.toHaveBeenCalled();
  });

  it('says so when there is nothing to ask', async () => {
    const { run } = setup([]);
    expect(await run('hello')).toContain('no usable SQL connection');
  });

  it('shows the structure for /schema without asking the model', async () => {
    const { run, sent } = setup([shop]);
    const out = await run('', 'schema');
    expect(out).toContain('orders(id int pk)');
    expect(sent).toEqual([]);
  });

  it('explains that /schema needs a scope when the digest is empty', async () => {
    const { run, tools } = setup([shop]);
    tools.schemaDigest.mockResolvedValueOnce('');
    expect(await run('', 'schema')).toContain('needs a database or schema');
  });

  it('explains SQL for /explain and runs nothing', async () => {
    const { run, tools, sent } = setup([shop, prod], 'It reads one row.');
    const out = await run('```sql\nSELECT * FROM orders\n```', 'explain');
    expect(sent[0]).toContain('SELECT * FROM orders');
    expect(out).toContain('It reads one row.');
    expect(tools.runReadOnlyQuery).not.toHaveBeenCalled();
  });

  it('does nothing but explain that the tools are off while the setting is off', async () => {
    const { run, tools, setEnabled, sent } = setup([shop]);
    setEnabled(false);
    expect(await run('q')).toContain('turned off');
    expect(tools.schemaDigest).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('reports a failure in the chat and in the log instead of throwing', async () => {
    const { run, tools, logger } = setup([shop]);
    tools.schemaDigest.mockRejectedValueOnce(new Error('connection lost'));
    expect(await run('q')).toContain('connection lost');
    expect(logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });
});
