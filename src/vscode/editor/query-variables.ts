// The question for the value of a query variable (V10.2.1); the rest of the work —
// finding the variables, remembering, substituting — is in services/query-variables.

import * as vscode from 'vscode';

export function askVariableValue(
  name: string,
  index: number,
  count: number,
  last: string | undefined,
): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title:
      count === 1
        ? vscode.l10n.t('Value of "{0}"', name)
        : vscode.l10n.t('Value of "{0}" ({1} of {2})', name, index + 1, count),
    prompt: vscode.l10n.t(
      "A number, NULL or text. Text in single quotes stays text even if it looks like a number: '42'.",
    ),
    ...(last === undefined ? {} : { value: last }),
    ignoreFocusOut: true,
  });
}
