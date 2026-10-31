import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import {
  type AdminChange,
  type AdminGrant,
  type AdminUser,
  userAdminProtocol,
  type UserAdminProtocol,
  type UserAdminState,
} from '../../../../../src/shared/protocols/user-admin';
import { RpcPeer } from '../../../../../src/shared/rpc';
import App from '../../../../../webview/src/apps/user-admin/App.svelte';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import { createLinkedTransports, flush } from '../../../../helpers/rpc';

type HostPeer = RpcPeer<UserAdminProtocol['host'], UserAdminProtocol['webview']>;

const STATE: UserAdminState = {
  connectionName: 'Local MySQL',
  server: 'MySQL',
  features: {
    hosts: true,
    tablesIn: 'database',
    passwordOptional: false,
    createOptions: [],
    lock: true,
    levels: [
      { level: 'server', privileges: ['SELECT', 'PROCESS'] },
      { level: 'database', privileges: ['SELECT', 'INSERT'] },
      { level: 'table', privileges: ['SELECT', 'UPDATE'] },
      { level: 'role', privileges: [] },
    ],
  },
  readOnly: false,
};

const USERS: AdminUser[] = [
  { name: 'app', host: '%', login: true, flags: [], memberOf: ['reader'] },
  { name: 'old', host: 'localhost', login: true, flags: ['locked'], memberOf: [] },
  { name: 'reader', host: '%', login: false, role: true, flags: [], memberOf: [] },
  { name: 'default', host: '%', login: true, flags: ['users.xml'], memberOf: [], readOnly: true },
];

const GRANTS: AdminGrant[] = [
  { level: 'table', database: 'shop', name: 'orders', privilege: 'UPDATE', grantable: true },
  { level: 'server', privilege: 'PROCESS', grantable: false },
  {
    level: 'table',
    database: 'shop',
    name: 'c',
    privilege: 'SELECT (id)',
    grantable: false,
    fixed: true,
  },
];

interface Calls {
  previews: AdminChange[];
  runs: AdminChange[];
  editors: AdminChange[];
  users: number;
  objects: string[];
}

async function setup(
  state: UserAdminState = STATE,
  options: { done?: boolean; previewError?: string; runError?: string } = {},
): Promise<{ host: HostPeer; calls: Calls }> {
  const transports = createLinkedTransports();
  const host: HostPeer = new RpcPeer({
    local: userAdminProtocol.host,
    remote: userAdminProtocol.webview,
    transport: transports.host,
  });
  const rpc = new RpcPeer({
    local: userAdminProtocol.webview,
    remote: userAdminProtocol.host,
    transport: transports.webview,
  });
  const calls: Calls = { previews: [], runs: [], editors: [], users: 0, objects: [] };
  host.handle('users', () => {
    calls.users += 1;
    return { rows: USERS };
  });
  host.handle('grants', ({ user }) => ({ rows: user.name === 'app' ? GRANTS : [] }));
  host.handle('objects', ({ kind }) => {
    calls.objects.push(kind);
    return { names: kind === 'database' ? ['shop', 'crm'] : ['orders'] };
  });
  host.handle('preview', ({ change }) => {
    calls.previews.push(change);
    if (options.previewError !== undefined) {
      throw new Error(options.previewError);
    }
    return {
      statements: [
        change.kind === 'create'
          ? "CREATE USER 'n'@'%' IDENTIFIED BY '********'"
          : `${change.kind.toUpperCase()} …`,
      ],
    };
  });
  host.handle('run', ({ change }) => {
    calls.runs.push(change);
    if (options.runError !== undefined) {
      throw new Error(options.runError);
    }
    return { done: options.done ?? true };
  });
  host.handle('openInEditor', ({ change }) => {
    calls.editors.push(change);
    return {};
  });
  host.on('ready', () => {
    host.emit('state', state);
  });
  render(App, { props: { rpc, t: createTranslator('en') } });
  await flush();
  return { host, calls };
}

async function pick(label: string): Promise<void> {
  await fireEvent.click(
    await screen.findByRole('button', {
      name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'),
    }),
  );
}

describe('users and privileges page', () => {
  it('lists accounts with their marks and shows where it works', async () => {
    await setup();
    await screen.findByText('app@%');
    expect(screen.getByTestId('where').textContent).toContain('Local MySQL · MySQL');
    expect(screen.getByText('locked')).toBeTruthy();
    expect(screen.getByText('role')).toBeTruthy();
    expect(screen.getByText('Pick a user, or make a new one.')).toBeTruthy();
  });

  it('filters accounts', async () => {
    await setup();
    await screen.findByText('app@%');
    await fireEvent.input(screen.getByLabelText('Filter'), { target: { value: 'local' } });
    expect(screen.queryByText('app@%')).toBeNull();
    expect(screen.getByText('old@localhost')).toBeTruthy();
  });

  it('shows the privileges of an account, sorted, revocable unless fixed', async () => {
    await setup();
    await pick('app@%');
    const table = await screen.findByTestId('grants');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(
      rows.map((row) =>
        [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim()).join('|'),
      ),
    ).toEqual([
      'Whole server|*|PROCESS||Revoke',
      'Table|shop.c|SELECT (id)||',
      'Table|shop.orders|UPDATE|yes|Revoke',
    ]);
    // The mark is an icon; the word is there for screen readers.
    const mark = rows[2]?.querySelectorAll('td')[3];
    expect(mark?.querySelector('.codicon-glyph')).not.toBeNull();
    expect(mark?.querySelector('.sr-only')?.textContent).toBe('yes');
    expect(screen.getByText('Member of: reader')).toBeTruthy();
  });

  it('previews a revoke and runs it, then reads again', async () => {
    const { calls } = await setup();
    await pick('app@%');
    const table = await screen.findByTestId('grants');
    const [, revoke] = within(table).getAllByRole('button', { name: 'Revoke' });
    if (revoke === undefined) {
      throw new Error('The orders grant has no Revoke');
    }
    await fireEvent.click(revoke);
    const preview = await screen.findByTestId('preview');
    expect(preview.textContent).toContain('REVOKE …');
    expect(calls.previews[0]).toEqual({
      kind: 'revoke',
      user: { name: 'app', host: '%' },
      target: { level: 'table', database: 'shop', name: 'orders' },
      privileges: ['UPDATE'],
      grantable: true,
    });
    await fireEvent.click(within(preview).getByRole('button', { name: 'Run' }));
    await screen.findByText('Done.');
    expect(calls.runs).toHaveLength(1);
    expect(calls.users).toBe(2);
    expect(screen.queryByTestId('preview')).toBeNull();
  });

  it('keeps the preview when the run was declined, and shows a failed run', async () => {
    const declined = await setup(STATE, { done: false });
    await pick('app@%');
    await fireEvent.click(await screen.findByRole('button', { name: 'Lock' }));
    await fireEvent.click(
      within(await screen.findByTestId('preview')).getByRole('button', { name: 'Run' }),
    );
    await waitFor(() => {
      expect(declined.calls.runs).toHaveLength(1);
    });
    expect(screen.getByTestId('preview')).toBeTruthy();
    expect(declined.calls.previews[0]).toEqual({ kind: 'lock', user: { name: 'app', host: '%' } });
  });

  it('shows the error of a failed run', async () => {
    await setup(STATE, { runError: 'Access denied; you need CREATE USER' });
    await pick('old@localhost');
    await fireEvent.click(await screen.findByRole('button', { name: 'Unlock' }));
    await fireEvent.click(
      within(await screen.findByTestId('preview')).getByRole('button', { name: 'Run' }),
    );
    expect((await screen.findByRole('alert')).textContent).toContain('CREATE USER');
  });

  it('creates a user with a host and a password, previewed first', async () => {
    const { calls } = await setup();
    await fireEvent.click(await screen.findByRole('button', { name: 'New user…' }));
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: ' new ' } });
    await fireEvent.input(screen.getByLabelText('Host (% — any)'), { target: { value: '10.0.%' } });
    await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Preview SQL' }));
    const preview = await screen.findByTestId('preview');
    expect(preview.textContent).toContain("IDENTIFIED BY '********'");
    expect(calls.previews[0]).toEqual({
      kind: 'create',
      user: { name: 'new', host: '10.0.%' },
      password: 'pw',
      options: [],
    });
    await fireEvent.click(within(preview).getByRole('button', { name: 'Open in editor' }));
    await waitFor(() => {
      expect(calls.editors).toHaveLength(1);
    });
  });

  it('offers PostgreSQL options and an optional password', async () => {
    const { calls } = await setup({
      ...STATE,
      server: 'PostgreSQL',
      features: {
        hosts: false,
        tablesIn: 'schema',
        passwordOptional: true,
        createOptions: ['login', 'superuser', 'createdb', 'createrole'],
        lock: false,
        levels: [{ level: 'schema', privileges: ['USAGE'] }],
      },
    });
    await fireEvent.click(await screen.findByRole('button', { name: 'New user…' }));
    expect(screen.queryByLabelText('Host (% — any)')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Can log in').checked).toBe(true);
    await fireEvent.click(screen.getByLabelText('Can create databases'));
    await fireEvent.click(screen.getByLabelText('Can log in'));
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'readers' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Preview SQL' }));
    await waitFor(() => {
      expect(calls.previews[0]).toEqual({
        kind: 'create',
        user: { name: 'readers' },
        password: '',
        options: ['createdb'],
      });
    });
    expect(screen.queryByRole('button', { name: 'Lock' })).toBeNull();
  });

  it('grants privileges on a table with suggestions, and a role', async () => {
    const { calls } = await setup();
    await pick('app@%');
    await fireEvent.click(await screen.findByRole('button', { name: 'Grant…' }));
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Preview SQL' });
    await fireEvent.change(screen.getByLabelText('Level'), { target: { value: 'table' } });
    await fireEvent.focus(screen.getByLabelText('Database'));
    await waitFor(() => {
      expect(calls.objects).toEqual(['database']);
    });
    await fireEvent.input(screen.getByLabelText('Database'), { target: { value: 'shop' } });
    await fireEvent.input(screen.getByLabelText('Object'), { target: { value: 'orders' } });
    expect(submit.disabled).toBe(true);
    await fireEvent.click(screen.getByLabelText('UPDATE'));
    await fireEvent.click(screen.getByLabelText('May pass them on (WITH GRANT OPTION)'));
    expect(submit.disabled).toBe(false);
    await fireEvent.click(submit);
    await waitFor(() => {
      expect(calls.previews.at(-1)).toEqual({
        kind: 'grant',
        user: { name: 'app', host: '%' },
        target: { level: 'table', database: 'shop', name: 'orders' },
        privileges: ['UPDATE'],
        grantable: true,
      });
    });
    await fireEvent.change(screen.getByLabelText('Level'), { target: { value: 'role' } });
    await fireEvent.input(screen.getByLabelText('Role'), { target: { value: 'reader' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Preview SQL' }));
    await waitFor(() => {
      expect(calls.previews.at(-1)).toMatchObject({
        kind: 'grant',
        target: { level: 'role', name: 'reader', host: '%' },
        privileges: [],
      });
    });
  });

  it('changes a password and drops a role', async () => {
    const { calls } = await setup();
    await pick('app@%');
    await fireEvent.click(await screen.findByRole('button', { name: 'Change password' }));
    await fireEvent.input(screen.getByLabelText('New password'), { target: { value: 'n3w' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Preview SQL' }));
    await waitFor(() => {
      expect(calls.previews[0]).toEqual({
        kind: 'password',
        user: { name: 'app', host: '%' },
        password: 'n3w',
      });
    });
    await pick('reader@%');
    expect(screen.queryByRole('button', { name: 'Change password' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Drop role' }));
    await waitFor(() => {
      expect(calls.previews.at(-1)).toEqual({
        kind: 'drop',
        user: { name: 'reader', host: '%' },
        role: true,
      });
    });
  });

  it('shows a refused preview as an error', async () => {
    await setup(STATE, { previewError: 'The user name is empty' });
    await pick('app@%');
    await fireEvent.click(await screen.findByRole('button', { name: 'Drop user' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The user name is empty');
    expect(screen.queryByTestId('preview')).toBeNull();
  });

  it('previews but never runs on a read-only connection', async () => {
    await setup({ ...STATE, readOnly: true });
    expect(await screen.findByText(/read-only/u)).toBeTruthy();
    await pick('app@%');
    await fireEvent.click(await screen.findByRole('button', { name: 'Drop user' }));
    const preview = await screen.findByTestId('preview');
    expect(within(preview).getByRole<HTMLButtonElement>('button', { name: 'Run' }).disabled).toBe(
      true,
    );
  });

  it('changes nothing of accounts kept in the server files', async () => {
    await setup();
    await pick('default@%');
    expect(await screen.findByText(/cannot be changed with SQL/u)).toBeTruthy();
    for (const name of ['Change password', 'Lock', 'Grant…', 'Drop user']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('shows why the page could not start', async () => {
    await setup({ connectionName: 'File', readOnly: false, error: 'A SQLite file has no users' });
    expect((await screen.findByRole('alert')).textContent).toBe('A SQLite file has no users');
    expect(screen.queryByRole('button', { name: 'New user…' })).toBeNull();
  });

  it('shows which form is open on its button (V11)', async () => {
    await setup();
    const create = await screen.findByRole('button', { name: 'New user…' });
    expect(create.getAttribute('aria-pressed')).toBe('false');
    await fireEvent.click(create);
    expect(create.getAttribute('aria-pressed')).toBe('true');
    await pick('app@%');
    expect(create.getAttribute('aria-pressed')).toBe('false');
    const grant = await screen.findByRole('button', { name: 'Grant…' });
    const password = screen.getByRole('button', { name: 'Change password' });
    await fireEvent.click(grant);
    expect(grant.getAttribute('aria-pressed')).toBe('true');
    expect(password.getAttribute('aria-pressed')).toBe('false');
    await fireEvent.click(password);
    expect(password.getAttribute('aria-pressed')).toBe('true');
    expect(grant.getAttribute('aria-pressed')).toBe('false');
  });

  it('reads the accounts again from the toolbar (V11)', async () => {
    const { calls } = await setup();
    await screen.findByText('app@%');
    expect(calls.users).toBe(1);
    await fireEvent.click(
      within(screen.getByRole('toolbar', { name: 'Users' })).getByRole('button', {
        name: 'Refresh',
      }),
    );
    await waitFor(() => {
      expect(calls.users).toBe(2);
    });
  });
});
