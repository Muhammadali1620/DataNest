// The Loki commands of the editor (V13.27), free of `vscode`: they write the `# range:` and
// `# tail:` comment lines (D155) at the top of the open query, so the window of a query is set
// from a menu instead of by typing. What the dialogs ask comes in through `LokiCommandUi`.

import { parseDuration } from '../../drivers/loki/time';
import { MAX_TAIL_MS } from '../../drivers/loki/directives';
import { msg } from '../../core/user-message';
import type { ConnectionStore } from '../../services/connection-store';
import { leadingDirective, setLeadingDirective } from '../../services/loki-directive';
import type { DocumentBindings } from '../editor/document-bindings';

/** Windows the picker offers; the last choice of the picker is a time typed by hand. */
export const RANGE_CHOICES = ['5m', '15m', '1h', '6h', '24h', '7d', '30d'] as const;
export const TAIL_CHOICES = ['30s', '1m', '5m', '10m', 'forever'] as const;

/** The open query: where it lives and how to rewrite its text. */
export interface LokiEditor {
  readonly uri: string;
  readonly text: string;
  replaceText(text: string): Promise<void>;
}

export interface LokiCommandUi {
  /** Picks one of the choices (the current one marked); undefined when the user backs out. */
  pick(
    title: string,
    choices: readonly string[],
    current: string | undefined,
  ): Promise<string | undefined>;
  /** Asks for a time written like `2h`; undefined when the user backs out. */
  inputDuration(
    title: string,
    prompt: string,
    check: (text: string) => string | undefined,
  ): Promise<string | undefined>;
  warn(message: string): void;
}

export interface LokiCommandDeps {
  readonly store: Pick<ConnectionStore, 'get'>;
  readonly bindings: Pick<DocumentBindings, 'get'>;
  readonly activeEditor: () => LokiEditor | undefined;
  readonly ui: LokiCommandUi;
}

export type LokiCommandName = 'setRange' | 'follow';

/** What is wrong with a window typed by hand, or undefined when Loki can use it. */
export function durationProblem(text: string, maxMs: number): string | undefined {
  const ms = parseDuration(text);
  if (ms === undefined) {
    return msg('Write a time like 15m, 2h or 7d');
  }
  return ms > maxMs ? msg('That is longer than allowed here') : undefined;
}

const CUSTOM = (): string => msg('Other…');

export function lokiCommandHandlers(
  deps: LokiCommandDeps,
): Record<LokiCommandName, () => Promise<void>> {
  /** The open query, if it is bound to a Loki connection; says why not otherwise. */
  const lokiEditor = (): LokiEditor | undefined => {
    const editor = deps.activeEditor();
    if (editor === undefined) {
      deps.ui.warn(msg('Open a query editor first'));
      return undefined;
    }
    const binding = deps.bindings.get(editor.uri);
    if (binding === undefined || deps.store.get(binding.connectionId)?.driver !== 'loki') {
      deps.ui.warn(msg('This editor is not connected to Grafana Loki'));
      return undefined;
    }
    return editor;
  };

  const choose = async (
    editor: LokiEditor,
    key: 'range' | 'tail',
    title: string,
    choices: readonly string[],
    maxMs: number,
  ): Promise<void> => {
    const current = leadingDirective(editor.text, key);
    const picked = await deps.ui.pick(title, [...choices, CUSTOM()], current);
    if (picked === undefined) {
      return;
    }
    const value =
      picked === CUSTOM()
        ? await deps.ui.inputDuration(title, msg('How long, written like 15m, 2h or 7d'), (text) =>
            durationProblem(text.trim(), maxMs),
          )
        : picked;
    if (value === undefined) {
      return;
    }
    await editor.replaceText(setLeadingDirective(editor.text, key, value.trim()));
  };

  return {
    setRange: async () => {
      const editor = lokiEditor();
      if (editor !== undefined) {
        await choose(
          editor,
          'range',
          msg('How far back should the query look'),
          RANGE_CHOICES,
          366 * 86_400_000,
        );
      }
    },
    follow: async () => {
      const editor = lokiEditor();
      if (editor !== undefined) {
        await choose(
          editor,
          'tail',
          msg('How long should the query follow new lines'),
          TAIL_CHOICES,
          MAX_TAIL_MS,
        );
      }
    },
  };
}
