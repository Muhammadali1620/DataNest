import { mount } from 'svelte';
import { erDiagramProtocol } from '../../../../src/shared/protocols/er-diagram';
import { RpcPeer } from '../../../../src/shared/rpc';
import { pageTranslator } from '../../lib/i18n';
import { createWebviewTransport, getVsCodeApi } from '../../lib/vscode-api';
import '../../styles/base.css';
import '../../styles/controls.css';
import App from './App.svelte';
import { canvasMeasure } from './picture';

const target = document.getElementById('app');
if (!target) {
  throw new Error('Webview root element #app is missing');
}

const rpc = new RpcPeer({
  local: erDiagramProtocol.webview,
  remote: erDiagramProtocol.host,
  transport: createWebviewTransport(getVsCodeApi()),
});

const font =
  getComputedStyle(document.body).getPropertyValue('--vscode-font-family').trim() || 'sans-serif';

mount(App, { target, props: { rpc, t: pageTranslator(), measure: canvasMeasure(font) } });
