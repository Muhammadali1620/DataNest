import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFiles, ROOT } from '../../helpers/repo';

const FACTORY = 'src/vscode/panels/webview-panel.ts';

describe('webview panels', () => {
  it('keep their page while the tab is hidden, so typed and chosen things stay (D130)', () => {
    expect(readFileSync(join(ROOT, FACTORY), 'utf8')).toContain('retainContextWhenHidden: true');
  });

  it('are all created by that one function, so none is left out', () => {
    const makers = listFiles('src').filter(
      (file) =>
        file.endsWith('.ts') &&
        readFileSync(join(ROOT, file), 'utf8').includes('createWebviewPanel('),
    );
    expect(makers).toEqual([FACTORY]);
  });
});
