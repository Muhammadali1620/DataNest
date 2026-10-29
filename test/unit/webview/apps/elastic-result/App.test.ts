import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  elasticResultProtocol,
  type ElasticResultProtocol,
  type ElasticResultState,
} from '../../../../../src/shared/protocols/elastic-result';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/elastic-result/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<ElasticResultProtocol['host'], ElasticResultProtocol['webview']>;

function state(overrides: Partial<ElasticResultState> = {}): ElasticResultState {
  return {
    connectionName: 'Search',
    request: 'POST /products/_search',
    status: 200,
    tookMs: 9,
    summary: { kind: 'hits', total: '10000', relation: 'gte', shown: 2, took: 3 },
    columns: ['_id', 'name', 'stock'],
    rows: [
      {
        cells: [
          { text: 'big', type: 'string' },
          { text: 'Big', type: 'string' },
          { text: '9007199254740993', type: 'number' },
        ],
        text: '{\n  "_id": "big"\n}',
      },
      {
        cells: [{ text: 'p1', type: 'string' }, { text: 'One', type: 'string' }, null],
        text: '{\n  "_id": "p1"\n}',
      },
    ],
    text: '{\n  "hits": {}\n}',
    truncated: false,
    ...overrides,
  };
}

async function open(initial: ElasticResultState) {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: elasticResultProtocol.host,
    remote: elasticResultProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: elasticResultProtocol.webview,
    remote: elasticResultProtocol.host,
    transport: transports.webview,
  });
  const ready = vi.fn();
  host.on('ready', ready);
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  expect(ready).toHaveBeenCalled();
  host.emit('state', initial);
  await waitFor(() => {
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeNull();
  });
  return host;
}

describe('Elasticsearch result page (V7.8)', () => {
  it('shows the request, its status, the hits and the summary', async () => {
    await open(state());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('POST /products/_search');
    expect(screen.getByTestId('status').textContent).toBe('200');
    expect(screen.getByTestId('meta').textContent).toContain('server: 3 ms');
    expect(screen.getByTestId('summary').textContent).toBe('at least 10 000 hits, 2 shown');
    const cells = screen.getAllByRole('cell');
    expect(cells.find((cell) => cell.textContent === '9007199254740993')?.className).toContain(
      'number',
    );
    expect(cells.some((cell) => cell.classList.contains('missing'))).toBe(true);
  });

  it('switches to the whole answer, and copies hits or all of it', async () => {
    const host = await open(state());
    const copy = vi.fn(() => ({}));
    host.handle('copy', copy);
    await fireEvent.click(screen.getByLabelText('Select hit 2'));
    await fireEvent.click(screen.getByRole('button', { name: 'Copy (1)' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Copy the answer' }));
    await waitFor(() => {
      expect(copy.mock.calls.map((call) => (call as unknown[])[0])).toEqual([{ rows: [1] }, {}]);
    });
    await fireEvent.click(screen.getByRole('tab', { name: 'Answer' }));
    expect(screen.getByTestId('text').textContent).toBe('{\n  "hits": {}\n}');
  });

  it('shows an answer without hits as text, and a failure in red', async () => {
    await open(
      state({
        status: 404,
        summary: { kind: 'error', error: 'index_not_found_exception: no such index' },
        columns: [],
        rows: [],
        truncated: true,
      }),
    );
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByTestId('status').className).toContain('failed');
    expect(screen.getByTestId('summary').className).toContain('error');
    expect(screen.getByText(/too large to show whole/)).toBeTruthy();
  });

  it('words counts and empty answers', async () => {
    const host = await open(
      state({ summary: { kind: 'count', total: '31' }, rows: [], columns: [] }),
    );
    expect(screen.getByTestId('summary').textContent).toBe('31 documents');
    host.emit(
      'state',
      state({ summary: { kind: 'empty' }, rows: [], columns: [], request: 'HEAD /x' }),
    );
    await waitFor(() => {
      expect(screen.getByTestId('summary').textContent).toBe('The answer has no body');
    });
  });
});
