import { mount } from 'svelte';
import '../../styles/base.css';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) {
  throw new Error('Webview root element #app is missing');
}
mount(App, { target });
