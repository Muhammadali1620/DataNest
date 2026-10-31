import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  type TestDataChoice,
  testDataProtocol,
  type TestDataProtocol,
  type TestDataState,
} from '../../../../../src/shared/protocols/test-data';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/test-data/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<TestDataProtocol['host'], TestDataProtocol['webview']>;

function state(overrides: Partial<TestDataState> = {}): TestDataState {
  return {
    driver: 'mysql',
    table: 'shop.people',
    columns: [
      { name: 'id', dataType: 'int', nullable: false, locked: 'auto', unique: true },
      { name: 'email', dataType: 'varchar(100)', nullable: false, unique: true },
      { name: 'note', dataType: 'text', nullable: true, unique: false },
      { name: 'team_id', dataType: 'int', nullable: true, unique: false, reference: 'teams.id' },
    ],
    choices: [
      { generator: 'default', nullPercent: 0 },
      { generator: 'email', nullPercent: 0 },
      { generator: 'sentence', nullPercent: 0 },
      { generator: 'reference', nullPercent: 0 },
    ],
    count: 100,
    seed: 7,
    ...overrides,
  };
}

async function setup(initial: TestDataState = state()) {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: testDataProtocol.host,
    remote: testDataProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: testDataProtocol.webview,
    remote: testDataProtocol.host,
    transport: transports.webview,
  });
  const previews: { choices: TestDataChoice[]; seed: number }[] = [];
  const inserts: { count: number; seed: number }[] = [];
  const scripts: number[] = [];
  let problems: { column: string; problem: string }[] = [];
  let previewError: string | undefined;
  host.handle('preview', (request) => {
    previews.push(request);
    if (previewError !== undefined) {
      throw new Error(previewError);
    }
    return { rows: [[null, 'anna.smith1@example.com', null, '3']], problems };
  });
  host.handle('insert', ({ count, seed }) => {
    inserts.push({ count, seed });
    return { started: true };
  });
  host.handle('openSql', ({ count }) => {
    scripts.push(count);
    return { opened: true };
  });
  const cancelled = vi.fn();
  host.on('cancel', cancelled);
  render(App, { props: { rpc, t: createTranslator('en'), previewDelay: 0 } });
  await flush();
  host.emit('state', initial);
  await waitFor(() => {
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeNull();
  });
  return {
    host,
    previews,
    inserts,
    scripts,
    cancelled,
    setProblems: (next: typeof problems) => {
      problems = next;
    },
    failPreview: (message: string) => {
      previewError = message;
    },
  };
}

describe('test data page', () => {
  it('shows each column with its generator, and the preview', async () => {
    await setup();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Test data for shop.people');
    expect(screen.getByText('numbered by the database')).not.toBeNull();
    expect(screen.getByLabelText<HTMLSelectElement>('What fills email').value).toBe('email');
    expect(screen.queryByLabelText('Share of NULL in email, %')).toBeNull();
    expect(screen.getByLabelText('Share of NULL in note, %')).not.toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('preview').textContent).toContain('anna.smith1@example.com');
    });
    expect(screen.getByText('Columns filled: 3 of 4')).not.toBeNull();
  });

  it('previews again with the new generator, NULL share or seed', async () => {
    const page = await setup();
    await fireEvent.change(screen.getByLabelText('What fills note'), {
      target: { value: 'words' },
    });
    await waitFor(() => {
      expect(page.previews.at(-1)?.choices[2]).toEqual({ generator: 'words', nullPercent: 0 });
    });
    await fireEvent.change(screen.getByLabelText('Share of NULL in note, %'), {
      target: { value: '250' },
    });
    await waitFor(() => {
      expect(page.previews.at(-1)?.choices[2]?.nullPercent).toBe(100);
    });
    await fireEvent.click(screen.getByRole('button', { name: 'New' }));
    await waitFor(() => {
      expect(page.previews.at(-1)?.seed).not.toBe(7);
    });
  });

  it('inserts, shows progress and the result', async () => {
    const page = await setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    await waitFor(() => {
      expect(page.inserts).toEqual([{ count: 100, seed: 7 }]);
    });
    page.host.emit('progress', { done: 40, total: 100 });
    await waitFor(() => {
      expect(screen.getByText('Inserted 40 of 100')).not.toBeNull();
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => {
      expect(page.cancelled).toHaveBeenCalled();
    });
    page.host.emit('finished', { outcome: 'done', inserted: 100, durationMs: 3 });
    await waitFor(() => {
      expect(screen.getByTestId('report').textContent).toContain('Done: 100 rows inserted');
    });
  });

  it('opens the rows as SQL', async () => {
    const page = await setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Open as SQL' }));
    await waitFor(() => {
      expect(page.scripts).toEqual([100]);
    });
  });

  it('will not insert while a column cannot be filled, and says why', async () => {
    const page = await setup();
    page.setProblems([{ column: 'team_id', problem: 'no-references' }]);
    await fireEvent.change(screen.getByLabelText('What fills note'), {
      target: { value: 'words' },
    });
    await waitFor(() => {
      expect(screen.getByText('The referenced table has no rows to point at')).not.toBeNull();
    });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Insert' }).disabled).toBe(true);
  });

  it('refuses a row count out of range', async () => {
    await setup();
    await fireEvent.input(screen.getByLabelText('Rows'), { target: { value: '0' } });
    await waitFor(() => {
      expect(screen.getByText('From 1 to 1000000 rows')).not.toBeNull();
    });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Insert' }).disabled).toBe(true);
  });

  it('shows a stopped run with its reason', async () => {
    await setup(
      state({
        report: { outcome: 'stopped', inserted: 0, message: 'duplicate key', durationMs: 1 },
      }),
    );
    expect(screen.getByTestId('report').textContent).toContain(
      'Nothing was inserted: duplicate key',
    );
  });
});

describe('test data page layout (V11)', () => {
  it('shows the run as a progress bar, and the result by its kind', async () => {
    const page = await setup(state({ progress: { done: 10, total: 200 } }));
    const bar = within(screen.getByTestId('progress')).getByRole('progressbar', {
      name: 'Insert progress',
    });
    expect(bar.getAttribute('aria-valuenow')).toBe('10');
    expect(bar.getAttribute('aria-valuemax')).toBe('200');
    page.host.emit('finished', { outcome: 'done', inserted: 200, durationMs: 3 });
    const report = await screen.findByTestId('report');
    expect(report.classList.contains('success')).toBe(true);
    expect(screen.queryByTestId('progress')).toBeNull();
  });

  it('marks a stopped run as a warning and shows a failed preview as an error', async () => {
    const page = await setup(
      state({ report: { outcome: 'cancelled', inserted: 0, durationMs: 1 } }),
    );
    expect(screen.getByTestId('report').classList.contains('warning')).toBe(true);
    page.failPreview('The table is gone');
    await fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The table is gone');
  });

  it('marks the generator of a column that cannot be filled as invalid', async () => {
    const page = await setup();
    page.setProblems([{ column: 'team_id', problem: 'no-references' }]);
    await fireEvent.change(screen.getByLabelText('What fills note'), {
      target: { value: 'words' },
    });
    await waitFor(() => {
      expect(screen.getByLabelText('What fills team_id').getAttribute('aria-invalid')).toBe('true');
    });
    expect(screen.getByLabelText('What fills email').getAttribute('aria-invalid')).toBe('false');
  });
});
