import { randomBytes } from 'node:crypto';

/** Everything the HTML shell needs; URIs must already be converted with `webview.asWebviewUri`. */
export interface WebviewHtmlOptions {
  /** `webview.cspSource` of the panel. */
  readonly cspSource: string;
  readonly scriptUri: string;
  readonly styleUri?: string;
  readonly nonce: string;
  readonly title: string;
  /** UI language, `vscode.env.language`. */
  readonly lang?: string;
}

const NONCE_PATTERN = /^[A-Za-z0-9+/]+=*$/;

/** Where Vite writes webview bundles (scripts/build-config.mjs → WEBVIEW_OUT_DIR). */
export const WEBVIEW_ASSET_DIR = ['dist', 'webview'] as const;

const APP_NAME = /^[a-z][a-z0-9-]*$/;

/** Paths of an app's bundle, relative to the extension root. */
export function webviewAssetPaths(app: string): { script: string[]; style: string[] } {
  if (!APP_NAME.test(app)) {
    throw new Error(`Invalid webview app name: "${app}"`);
  }
  return {
    script: [...WEBVIEW_ASSET_DIR, `${app}.js`],
    style: [...WEBVIEW_ASSET_DIR, `${app}.css`],
  };
}

/** A fresh random nonce for every render: scripts without it are blocked by CSP. */
export function createNonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * Scripts run only with our nonce; styles, fonts and images load only from the extension.
 * Inline styles stay allowed because Svelte and the virtualized grid set `style` attributes.
 */
export function buildContentSecurityPolicy(cspSource: string, nonce: string): string {
  assertNonce(nonce);
  return [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
}

export function renderWebviewHtml(options: WebviewHtmlOptions): string {
  const csp = buildContentSecurityPolicy(options.cspSource, options.nonce);
  const style =
    options.styleUri === undefined
      ? ''
      : `\n    <link rel="stylesheet" href="${escapeHtml(options.styleUri)}" />`;
  return `<!DOCTYPE html>
<html lang="${escapeHtml(options.lang ?? 'en')}">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(options.title)}</title>${style}
  </head>
  <body>
    <div id="app"></div>
    <script type="module" nonce="${options.nonce}" src="${escapeHtml(options.scriptUri)}"></script>
  </body>
</html>
`;
}

function assertNonce(nonce: string): void {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error('Invalid CSP nonce');
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
