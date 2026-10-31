import { mount } from 'svelte';
import { toolsProtocol } from '../../../../src/shared/protocols/tools';
import { RpcPeer } from '../../../../src/shared/rpc';
import { pageTranslator } from '../../lib/i18n';
import { createWebviewTransport, getVsCodeApi } from '../../lib/vscode-api';
import '../../styles/base.css';
import '../../styles/controls.css';
import './tools.css';
import App from './App.svelte';
import { createToolsState } from './state';

const target = document.getElementById('app');
if (!target) {
  throw new Error('Webview root element #app is missing');
}

const rpc = new RpcPeer({
  local: toolsProtocol.webview,
  remote: toolsProtocol.host,
  transport: createWebviewTransport(getVsCodeApi()),
});

const api = getVsCodeApi();

mount(App, { target, props: { rpc, t: pageTranslator(), state: createToolsState(api) } });
