// The coloured icons of the "actions" list (D113): files of our own in resources/icons/actions,
// by the name of the editor icon they replace. Free of `vscode`, so a test can check them.

import { ACTION_ICONS } from '../../shared/icon-art';

/** Path segments of the icon's file under the extension folder; none where there is no file. */
export function actionIconPath(icon: string): string[] | undefined {
  return icon in ACTION_ICONS ? ['resources', 'icons', 'actions', `${icon}.svg`] : undefined;
}
