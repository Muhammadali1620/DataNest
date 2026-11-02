import { mount } from 'svelte';
import { rabbitObjectProtocol } from '../../../../src/shared/protocols/rabbitmq-object';
import { RpcPeer } from '../../../../src/shared/rpc';
import { pageTranslator } from '../../lib/i18n';
import { createWebviewTransport, getVsCodeApi } from '../../lib/vscode-api';
import '../../styles/base.css';
import '../../styles/controls.css';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) {
  throw new Error('Webview root element #app is missing');
}

const rpc = new RpcPeer({
  local: rabbitObjectProtocol.webview,
  remote: rabbitObjectProtocol.host,
  transport: createWebviewTransport(getVsCodeApi()),
});

mount(App, { target, props: { rpc, t: pageTranslator() } });
