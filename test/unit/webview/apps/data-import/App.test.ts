import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
  dataImportProtocol,
  type DataImportProtocol,
  type ImportMapping,
  type ImportOptions,
  type ImportPageState,
} from '../../../../../src/shared/protocols/data-import';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/data-import/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<DataImportProtocol['host'], DataImportProtocol['webview']>;

function state(overrides: Partial<ImportPageState> = {}): ImportPageState {
  return {
    driver: 'postgres',
    table: 'public.people',
    file: 'people.csv',
    size: 2048,
    columns: [
      {
        name: 'id',
        dataType: 'integer',
        nullable: false,
        hasDefault: true,
        autoIncrement: true,
        generated: false,
      },
      {
        name: 'name',
        dataType: 'text',
        nullable: true,
        hasDefault: false,
        autoIncrement: false,
        generated: false,
      },
      {
        name: 'twice',
        dataType: 'integer',
        nullable: true,
        hasDefault: true,
        autoIncrement: false,
        generated: true,
      },
    ],
    options: { format: 'csv', delimiter: ',', header: true, emptyIsNull: true, nullText: '' },
    source: {
      columns: ['id', 'name'],
      rows: [
        { line: 2, cells: ['1', 'Anna'] },
        { line: 3, cells: ['x', null] },
      ],
    },
    mapping: [0, 1, null],
    ...overrides,
  };
}

async function setup(initial: ImportPageState = state()) {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: dataImportProtocol.host,
    remote: dataImportProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: dataImportProtocol.webview,
    remote: dataImportProtocol.host,
    transport: transports.webview,
  });
  const loads: ImportOptions[] = [];
  const previews: ImportMapping[] = [];
  const starts: { mode: string; mapping: ImportMapping }[] = [];
  let started = true;
  host.handle('load', (options) => {
    loads.push(options);
    return { source: initial.source, mapping: [null, 0, null] };
  });
  host.handle('preview', ({ mapping }) => {
    previews.push(mapping);
    return {
      rows: [
        { line: 2, cells: [{ text: '1' }, { text: 'Anna' }, { fill: 'default' as const }] },
        {
          line: 3,
          cells: [{ problem: 'invalid-integer' }, { text: 'NULL' }, { fill: 'default' as const }],
        },
      ],
    };
  });
  host.handle('start', ({ mode, mapping }) => {
    starts.push({ mode, mapping });
    return { started };
  });
  const cancelled = vi.fn();
  const closed = vi.fn();
  host.on('cancel', cancelled);
  host.on('close', closed);
  render(App, { props: { rpc, t: createTranslator('en'), previewDelay: 0 } });
  await flush();
  host.emit('state', initial);
  await waitFor(() => {
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeNull();
  });
  return {
    host,
    loads,
    previews,
    starts,
    cancelled,
    closed,
    refuse: () => {
      started = false;
    },
  };
}

describe('data import page', () => {
  it('shows the file, the columns and where each one is filled from', async () => {
    await setup();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Import “people.csv” into public.people',
    );
    expect(screen.getByText('2 KB')).not.toBeNull();
    const from = screen.getByLabelText<HTMLSelectElement>('Where name is filled from');
    expect(from.value).toBe('1');
    expect(screen.queryByLabelText('Where twice is filled from')).toBeNull();
    expect(screen.getByText('computed by the database')).not.toBeNull();
    expect(screen.getByText('Columns filled from the file: 2 of 3')).not.toBeNull();
  });

  it('previews the converted rows, problems marked', async () => {
    await setup();
    await waitFor(() => {
      expect(screen.getByTestId('preview').textContent).toContain('Anna');
    });
    expect(screen.getByText('Enter a whole number')).not.toBeNull();
    expect(screen.getByText('Values that do not fit in the rows shown: 1')).not.toBeNull();
  });

  it('reads the file again when an option changes, and takes the new mapping', async () => {
    const page = await setup();
    await fireEvent.change(screen.getByLabelText('Delimiter'), { target: { value: ';' } });
    await waitFor(() => {
      expect(page.loads).toHaveLength(1);
    });
    expect(page.loads[0]?.delimiter).toBe(';');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLSelectElement>('Where id is filled from').value).toBe('');
    });
  });

  it('previews again when the mapping changes', async () => {
    const page = await setup();
    await fireEvent.change(screen.getByLabelText('Where id is filled from'), {
      target: { value: '' },
    });
    await waitFor(() => {
      expect(page.previews.at(-1)).toEqual([null, 1, null]);
    });
    expect(screen.getByText('Columns filled from the file: 1 of 3')).not.toBeNull();
  });

  it('starts with the chosen mode, shows progress, and the report at the end', async () => {
    const page = await setup();
    await fireEvent.click(screen.getByLabelText('Skip the rows that do not fit and keep the rest'));
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => {
      expect(page.starts).toEqual([{ mode: 'skip', mapping: [0, 1, null] }]);
    });
    await waitFor(() => {
      expect(screen.getByTestId('progress')).not.toBeNull();
    });
    page.host.emit('progress', { read: 10, inserted: 8, failed: 2, percent: 40 });
    await waitFor(() => {
      expect(screen.getByText('Read: 10 · imported: 8 · failed: 2')).not.toBeNull();
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => {
      expect(page.cancelled).toHaveBeenCalled();
    });
    page.host.emit('finished', {
      outcome: 'done',
      read: 12,
      inserted: 10,
      failedCount: 2,
      failures: [
        { line: 3, column: 'id', problem: 'invalid-integer' },
        { line: 7, message: 'duplicate key' },
      ],
      rolledBack: false,
      durationMs: 5,
    });
    await waitFor(() => {
      expect(screen.getByTestId('report').textContent).toContain(
        'Done: 10 rows imported, 2 left out',
      );
    });
    expect(screen.getByText('Line 3, column id: Enter a whole number')).not.toBeNull();
    expect(screen.getByText('Line 7: duplicate key')).not.toBeNull();
    expect(screen.queryByTestId('progress')).toBeNull();
  });

  it('stays put when the host does not start', async () => {
    const page = await setup();
    page.refuse();
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => {
      expect(page.starts).toHaveLength(1);
    });
    expect(screen.queryByTestId('progress')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Import' }).disabled).toBe(false);
  });

  it('cannot start with no column filled from the file', async () => {
    await setup(state({ mapping: [null, null, null] }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Import' }).disabled).toBe(true);
  });

  it('hides the CSV options for JSON, and closes', async () => {
    const page = await setup(
      state({
        options: { format: 'json', delimiter: ',', header: true, emptyIsNull: false, nullText: '' },
      }),
    );
    expect(screen.queryByLabelText('Delimiter')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(page.closed).toHaveBeenCalled();
    });
  });

  it('shows a run that was in progress when the page was hidden', async () => {
    await setup(state({ progress: { read: 5, inserted: 5, failed: 0, percent: 10 } }));
    expect(screen.getByText('Read: 5 · imported: 5 · failed: 0')).not.toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Import' }).disabled).toBe(true);
  });
});
