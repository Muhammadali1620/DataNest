import { describe, expect, it } from 'vitest';
import {
  buildContentSecurityPolicy,
  createNonce,
  renderWebviewHtml,
  type WebviewHtmlOptions,
} from '../../../../src/vscode/panels/webview-html';

const CSP_SOURCE = 'https://file+.vscode-resource.vscode-cdn.net';

const base: WebviewHtmlOptions = {
  cspSource: CSP_SOURCE,
  scriptUri: `${CSP_SOURCE}/ext/dist/webview/ping.js`,
  styleUri: `${CSP_SOURCE}/ext/dist/webview/ping.css`,
  nonce: 'abc123+/XYZ=',
  title: 'Ping',
};

function cspOf(html: string): string {
  const match = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
  if (!match?.[1]) {
    throw new Error('No CSP meta tag');
  }
  // The browser decodes entities in attribute values; so do we.
  return match[1].replaceAll('&#39;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&');
}

describe('createNonce', () => {
  it('returns 128 bits of base64', () => {
    const nonce = createNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(Buffer.from(nonce, 'base64')).toHaveLength(16);
  });

  it('never repeats', () => {
    const nonces = new Set(Array.from({ length: 1000 }, () => createNonce()));
    expect(nonces.size).toBe(1000);
  });

  it('is always accepted by the CSP builder', () => {
    for (let i = 0; i < 100; i++) {
      expect(() => buildContentSecurityPolicy(CSP_SOURCE, createNonce())).not.toThrow();
    }
  });
});

describe('buildContentSecurityPolicy', () => {
  const csp = buildContentSecurityPolicy(CSP_SOURCE, 'n0nce');
  const directives = new Map(
    csp.split('; ').map((d) => {
      const [name = '', ...values] = d.split(' ');
      return [name, values];
    }),
  );

  it('denies everything by default', () => {
    expect(directives.get('default-src')).toEqual(["'none'"]);
  });

  it('runs only scripts that carry the nonce', () => {
    expect(directives.get('script-src')).toEqual(["'nonce-n0nce'"]);
  });

  it('never allows eval or inline scripts', () => {
    expect(csp).not.toContain('unsafe-eval');
    expect(directives.get('script-src')).not.toContain("'unsafe-inline'");
  });

  it('loads styles, fonts and images only from the extension', () => {
    expect(directives.get('style-src')).toEqual([CSP_SOURCE, "'unsafe-inline'"]);
    expect(directives.get('font-src')).toEqual([CSP_SOURCE]);
    expect(directives.get('img-src')).toEqual([CSP_SOURCE, 'data:']);
  });

  it('allows no network access and no wildcards', () => {
    expect(directives.has('connect-src')).toBe(false);
    expect(csp).not.toMatch(/(^|\s)\*(\s|;|$)/);
    expect(csp).not.toMatch(/(^|\s)https?:(\s|;|$)/);
  });

  it.each([[''], ['a b'], ["x' 'unsafe-eval"], ['a;b'], ['"quote"'], ['=abc']])(
    'rejects the unsafe nonce %j',
    (nonce) => {
      expect(() => buildContentSecurityPolicy(CSP_SOURCE, nonce)).toThrow('Invalid CSP nonce');
    },
  );
});

describe('renderWebviewHtml', () => {
  it('produces a complete document with the app root', () => {
    const html = renderWebviewHtml(base);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<meta charset="UTF-8" />');
    expect(html).toContain('<div id="app"></div>');
    expect(html).toContain('<title>Ping</title>');
  });

  it('embeds the CSP with the same nonce as the script', () => {
    const html = renderWebviewHtml(base);
    expect(cspOf(html)).toBe(buildContentSecurityPolicy(CSP_SOURCE, base.nonce));
    expect(html).toContain(
      `<script type="module" nonce="${base.nonce}" src="${base.scriptUri}"></script>`,
    );
  });

  it('gives every script tag the nonce', () => {
    const html = renderWebviewHtml(base);
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) {
      expect(tag).toContain(`nonce="${base.nonce}"`);
    }
  });

  it('places the CSP before any resource is referenced', () => {
    const html = renderWebviewHtml(base);
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<link'));
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'));
  });

  it('links the stylesheet only when given', () => {
    expect(renderWebviewHtml(base)).toContain(`<link rel="stylesheet" href="${base.styleUri}" />`);
    const { styleUri: _ignored, ...withoutStyle } = base;
    expect(renderWebviewHtml(withoutStyle)).not.toContain('<link');
  });

  it('uses English by default and the given UI language otherwise', () => {
    expect(renderWebviewHtml(base)).toContain('<html lang="en">');
    expect(renderWebviewHtml({ ...base, lang: 'ru' })).toContain('<html lang="ru">');
  });

  it('escapes the title so it cannot inject markup', () => {
    const html = renderWebviewHtml({ ...base, title: '</title><script>alert(1)</script>' });
    expect(html).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(html.match(/<script\b/g)).toHaveLength(1);
  });

  it('escapes quotes in URIs and the language', () => {
    const html = renderWebviewHtml({
      ...base,
      scriptUri: 'x" onload="alert(1)',
      styleUri: "y' onload='alert(1)",
      lang: 'en" x="',
    });
    expect(html).not.toContain('" onload="');
    expect(html).not.toContain("' onload='");
    expect(html).toContain('src="x&quot; onload=&quot;alert(1)"');
    expect(html).toContain('href="y&#39; onload=&#39;alert(1)"');
    expect(html).toContain('<html lang="en&quot; x=&quot;">');
  });

  it('refuses to render with an invalid nonce', () => {
    expect(() => renderWebviewHtml({ ...base, nonce: '" onerror="x' })).toThrow(
      'Invalid CSP nonce',
    );
  });
});
