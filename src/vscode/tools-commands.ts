// "Open Tools" (V11.10): from the palette, the results toolbar or anywhere that asks.

import type * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import { ToolsPanel } from './panels/tools-panel';

export interface ToolsCommandDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
}

export function toolsCommandHandlers(deps: ToolsCommandDeps): { openTools: () => void } {
  return {
    openTools: () => {
      ToolsPanel.show(deps.extensionUri, deps.logger);
    },
  };
}
