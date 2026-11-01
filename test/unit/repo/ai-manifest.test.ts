// The tools and the chat participant for the editor's language model (V13.15) are
// declared in package.json under the names the code registers, with texts in both
// languages, and the setting that turns them off exists with the default "on".

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_TOOL_NAMES } from '../../../src/services/ai-tools';
import { CONFIG_KEYS, CONFIG_SECTION } from '../../../src/vscode/command-ids';
import { CHAT_PARTICIPANT_ID } from '../../../src/services/ai-chat';
import { ROOT } from '../../helpers/repo';

interface Tool {
  name: string;
  displayName: string;
  userDescription: string;
  modelDescription: string;
  toolReferenceName: string;
  inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] };
}

interface Participant {
  id: string;
  name: string;
  description: string;
  commands: { name: string; description: string }[];
}

const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');
const manifest = JSON.parse(read('package.json')) as {
  contributes: {
    languageModelTools: Tool[];
    chatParticipants: Participant[];
    configuration: {
      properties: Record<string, { type: string; default: unknown; markdownDescription: string }>;
    };
  };
  engines: { vscode: string };
};
const nls = JSON.parse(read('package.nls.json')) as Record<string, string>;
const nlsRu = JSON.parse(read('package.nls.ru.json')) as Record<string, string>;
const tools = manifest.contributes.languageModelTools;
const placeholder = (text: string): string => text.replace(/^%|%$/gu, '');

describe('language model tools', () => {
  it('are exactly the ones the code registers', () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.values(AI_TOOL_NAMES).sort());
  });

  it('have unique reference names, descriptions for the model and an object schema', () => {
    expect(new Set(tools.map((tool) => tool.toolReferenceName)).size).toBe(tools.length);
    for (const tool of tools) {
      expect(tool.modelDescription.length, tool.name).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('ask for the connection, and for a table or a statement where one is needed', () => {
    const required = (name: string): string[] =>
      tools.find((tool) => tool.name === name)?.inputSchema.required ?? [];
    expect(required(AI_TOOL_NAMES.listConnections)).toEqual([]);
    expect(required(AI_TOOL_NAMES.listTables)).toEqual(['connection']);
    expect(required(AI_TOOL_NAMES.describeTable)).toEqual(['connection', 'table']);
    expect(required(AI_TOOL_NAMES.runReadOnlyQuery)).toEqual(['connection', 'sql']);
  });

  it('promise the model nothing the code does not keep', () => {
    const query = tools.find((tool) => tool.name === AI_TOOL_NAMES.runReadOnlyQuery);
    expect(query?.modelDescription).toContain('only reads');
    expect(query?.modelDescription).toContain('100 rows');
    expect(query?.modelDescription).toContain('approve');
  });

  it('have their display texts in English and Russian', () => {
    for (const tool of tools) {
      for (const text of [tool.displayName, tool.userDescription]) {
        const key = placeholder(text);
        expect(nls[key], key).toBeTruthy();
        expect(nlsRu[key], key).toBeTruthy();
        expect(nlsRu[key]).not.toBe(nls[key]);
      }
    }
  });
});

describe('chat participant', () => {
  const [participant] = manifest.contributes.chatParticipants;

  it('is declared once, under the id the code registers', () => {
    expect(manifest.contributes.chatParticipants).toHaveLength(1);
    expect(participant?.id).toBe(CHAT_PARTICIPANT_ID);
    expect(participant?.name).toBe('datanest');
  });

  it('has the three commands the handler knows, with texts in both languages', () => {
    expect(participant?.commands.map((command) => command.name)).toEqual([
      'schema',
      'query',
      'explain',
    ]);
    for (const text of [
      participant?.description ?? '',
      ...(participant?.commands.map((command) => command.description) ?? []),
    ]) {
      const key = placeholder(text);
      expect(nls[key], key).toBeTruthy();
      expect(nlsRu[key], key).toBeTruthy();
    }
  });

  it('needs an editor that has the API (the minimum is far past it)', () => {
    expect(manifest.engines.vscode).toMatch(/\^1\.1\d\d\./u);
  });
});

describe('the setting', () => {
  const setting =
    manifest.contributes.configuration.properties[`${CONFIG_SECTION}.${CONFIG_KEYS.aiEnabled}`];

  it('is a boolean that is on by default', () => {
    expect(CONFIG_KEYS.aiEnabled).toBe('ai.enabled');
    expect(setting?.type).toBe('boolean');
    expect(setting?.default).toBe(true);
  });

  it('is described in both languages, and says passwords are never sent', () => {
    const key = placeholder(setting?.markdownDescription ?? '');
    expect(nls[key]).toContain('Passwords');
    expect(nlsRu[key]).toBeTruthy();
  });
});
