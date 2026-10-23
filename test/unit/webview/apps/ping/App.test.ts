import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import App from '../../../../../webview/src/apps/ping/App.svelte';

describe('ping App', () => {
  it('shows the product name by default', () => {
    render(App);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('DataNest');
    expect(screen.getByTestId('status').textContent).toBe('ready');
  });

  it('shows a custom title', () => {
    render(App, { props: { title: 'Hello' } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Hello');
  });

  it('renders text, not HTML, from props', () => {
    render(App, { props: { title: '<img src=x onerror=alert(1)>' } });
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.querySelector('img')).toBeNull();
    expect(heading.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
