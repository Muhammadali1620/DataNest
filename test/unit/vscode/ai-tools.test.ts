import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Registered {
  invoke: (options: { input: unknown }) => Promise<{ parts: { value: string }[] }>;
  prepareInvocation: (options: { input: unknown }) => {
    confirmationMessages?: { title: string; message: { value: string } };
  };
}

const registered = new Map<string, Registered>();
const hosted = { lm: true, chat: true };

vi.mock('vscode', () => {
  class MarkdownString {
    value = '';
    appendMarkdown(text: string): this {
      this.value += text;
      return this;
    }
    appendCodeblock(code: string, language: string): this {
      this.value += `\`\`\`${language}\n${code}\n\`\`\``;
      return this;
    }
  }
  class LanguageModelTextPart {
    constructor(readonly value: string) {}
  }
  class LanguageModelToolResult {
    constructor(readonly parts: LanguageModelTextPart[]) {}
  }
  const api = {
    MarkdownString,
    LanguageModelTextPart,
    LanguageModelToolResult,
    l10n: {
      t: (text: string, ...args: unknown[]) =>
        text.replace(/\{(\d+)\}/g, (_m, i: string) => String(args[Number(i)])),
    },
    get lm() {
      return hosted.lm
        ? {
            registerTool: (name: string, tool: Registered) => {
              registered.set(name, tool);
              return { dispose: () => registered.delete(name) };
            },
          }
        : undefined;
    },
    get chat() {
      return hosted.chat ? { createChatParticipant: vi.fn() } : undefined;
    },
  };
  return api;
});

import { AI_TOOL_NAMES, type AiTools } from '../../../src/services/ai-tools';
import { hasLanguageModelTools, registerAiTools } from '../../../src/vscode/ai-tools';
import { RecordingLogger } from '../../helpers/fakes';

function fakeTools() {
  return {
    listConnections: vi.fn(() => ({ text: '[]' })),
    listTables: vi.fn(() => Promise.resolve({ text: 'tables' })),
    describeTable: vi.fn(() => Promise.resolve({ text: 'table' })),
    runReadOnlyQuery: vi.fn(() => Promise.resolve({ text: 'rows' })),
    confirmationFor: vi.fn(),
  };
}

beforeEach(() => {
  registered.clear();
  hosted.lm = true;
  hosted.chat = true;
});

describe('registerAiTools', () => {
  it('registers the four tools under the names of the manifest', () => {
    const disposables = registerAiTools(fakeTools() as unknown as AiTools, new RecordingLogger());
    expect(disposables).toHaveLength(4);
    expect([...registered.keys()].sort()).toEqual(Object.values(AI_TOOL_NAMES).sort());
  });

  it('does nothing, and says so, in an editor without the language model API', () => {
    hosted.lm = false;
    const logger = new RecordingLogger();
    expect(hasLanguageModelTools()).toBe(false);
    expect(registerAiTools(fakeTools() as unknown as AiTools, logger)).toEqual([]);
    expect(registered.size).toBe(0);
    expect(logger.entries.map((entry) => entry.level)).toEqual(['info']);
  });

  it('hands the model input to the service and the answer back as text', async () => {
    const tools = fakeTools();
    registerAiTools(tools as unknown as AiTools, new RecordingLogger());
    const query = registered.get(AI_TOOL_NAMES.runReadOnlyQuery);
    const result = await query?.invoke({ input: { connection: 'Shop', sql: 'SELECT 1' } });
    expect(tools.runReadOnlyQuery).toHaveBeenCalledWith({ connection: 'Shop', sql: 'SELECT 1' });
    expect(result?.parts.map((part) => part.value)).toEqual(['rows']);
    const list = await registered.get(AI_TOOL_NAMES.listConnections)?.invoke({ input: {} });
    expect(list?.parts[0]?.value).toBe('[]');
    expect(tools.listTables).not.toHaveBeenCalled();
  });

  it('turns a failure into text for the model instead of throwing', async () => {
    const tools = fakeTools();
    tools.listTables.mockRejectedValueOnce(new Error('boom'));
    const logger = new RecordingLogger();
    registerAiTools(tools as unknown as AiTools, logger);
    const result = await registered
      .get(AI_TOOL_NAMES.listTables)
      ?.invoke({ input: { connection: 'x' } });
    expect(result?.parts[0]?.value).toContain('boom');
    expect(logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('asks the user before a query and shows the statement', () => {
    const tools = fakeTools();
    tools.confirmationFor.mockReturnValue({
      connection: 'Shop',
      production: false,
      sql: 'SELECT 1',
    });
    registerAiTools(tools as unknown as AiTools, new RecordingLogger());
    const prepared = registered.get(AI_TOOL_NAMES.runReadOnlyQuery)?.prepareInvocation({
      input: { connection: 'Shop', sql: 'SELECT 1' },
    });
    expect(tools.confirmationFor).toHaveBeenCalledWith(AI_TOOL_NAMES.runReadOnlyQuery, {
      connection: 'Shop',
      sql: 'SELECT 1',
    });
    expect(prepared?.confirmationMessages?.title).toBe('Run a query');
    expect(prepared?.confirmationMessages?.message.value).toContain('SELECT 1');
    expect(prepared?.confirmationMessages?.message.value).not.toContain('production');
  });

  it('says it is production, and asks about a structure read there', () => {
    const tools = fakeTools();
    tools.confirmationFor.mockReturnValue({ connection: 'Analytics', production: true });
    registerAiTools(tools as unknown as AiTools, new RecordingLogger());
    const prepared = registered.get(AI_TOOL_NAMES.describeTable)?.prepareInvocation({
      input: { connection: 'Analytics', table: 't' },
    });
    expect(prepared?.confirmationMessages?.title).toBe('Read the structure of a database');
    expect(prepared?.confirmationMessages?.message.value).toContain(
      '"Analytics" is a production database.',
    );
    expect(prepared?.confirmationMessages?.message.value).toContain(
      'read the structure of "Analytics"',
    );
  });

  it('asks nothing when the service wants nothing', () => {
    const tools = fakeTools();
    tools.confirmationFor.mockReturnValue(undefined);
    registerAiTools(tools as unknown as AiTools, new RecordingLogger());
    expect(registered.get(AI_TOOL_NAMES.listTables)?.prepareInvocation({ input: {} })).toEqual({});
  });
});
