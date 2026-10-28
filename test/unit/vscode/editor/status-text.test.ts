import { describe, expect, it } from 'vitest';
import type { ConnectionState } from '../../../../src/services/connection-manager';
import type { ConnectionConfig } from '../../../../src/shared/connection';
import { statusView, type StatusTexts } from '../../../../src/vscode/editor/status-text';

const TEXTS: StatusTexts = {
  pick: 'Select connection',
  tooltip: 'Choose the connection',
  connecting: 'connecting…',
  failed: 'failed',
  notConnected: 'not connected',
  production: 'PROD',
  readOnly: 'RO',
};

const config: ConnectionConfig = {
  id: 'c1',
  name: 'Local',
  driver: 'mysql',
  host: '127.0.0.1',
};

const connected: ConnectionState = { status: 'connected' };

describe('statusView', () => {
  it('invites the user to pick when the document has no connection', () => {
    const view = statusView(undefined, undefined, { status: 'disconnected' }, TEXTS);
    expect(view).toEqual({
      text: 'Select connection',
      tooltip: 'Choose the connection',
      warning: false,
    });
  });

  it('shows the connection name once connected', () => {
    const view = statusView({ connectionId: 'c1' }, config, connected, TEXTS);
    expect(view.text).toBe('Local');
    expect(view.warning).toBe(false);
  });

  it('adds the database the document is pinned to', () => {
    const view = statusView({ connectionId: 'c1', database: 'app' }, config, connected, TEXTS);
    expect(view.text).toBe('Local · app');
    expect(view.tooltip.startsWith('Local · app')).toBe(true);
  });

  it('shows the state while it is not connected yet', () => {
    expect(statusView({ connectionId: 'c1' }, config, { status: 'connecting' }, TEXTS).text).toBe(
      'Local (connecting…)',
    );
    expect(statusView({ connectionId: 'c1' }, config, { status: 'disconnected' }, TEXTS).text).toBe(
      'Local (not connected)',
    );
  });

  it('warns when the connection failed', () => {
    const view = statusView(
      { connectionId: 'c1', database: 'app' },
      config,
      { status: 'error', error: 'Access denied' },
      TEXTS,
    );
    expect(view.text).toBe('Local · app (failed)');
    expect(view.warning).toBe(true);
  });

  it('falls back to the invitation, with a warning, when the connection was deleted', () => {
    const view = statusView({ connectionId: 'gone' }, undefined, { status: 'disconnected' }, TEXTS);
    expect(view.text).toBe('Select connection');
    expect(view.warning).toBe(true);
  });

  it('always tells the user what a click does', () => {
    for (const state of [
      { status: 'connected' } as const,
      { status: 'connecting' } as const,
      { status: 'error' } as const,
      { status: 'disconnected' } as const,
    ]) {
      expect(statusView({ connectionId: 'c1' }, config, state, TEXTS).tooltip).toContain(
        'Choose the connection',
      );
    }
  });
});

describe('statusView of guarded connections', () => {
  const binding = { connectionId: 'c1' };
  const connected = { status: 'connected' as const };

  it('marks a production connection and asks for the error color', () => {
    const view = statusView(
      binding,
      { id: 'c1', name: 'Live', driver: 'mysql', production: true },
      connected,
      TEXTS,
    );
    expect(view.text).toBe('PROD Live');
    expect(view.production).toBe(true);
  });

  it('marks a read-only connection without the error color', () => {
    const view = statusView(
      binding,
      { id: 'c1', name: 'Replica', driver: 'mysql', readOnly: true, production: true },
      { status: 'disconnected' },
      TEXTS,
    );
    expect(view.text).toBe('PROD RO Replica (not connected)');
    const plain = statusView(
      binding,
      { id: 'c1', name: 'R', driver: 'mysql', readOnly: true },
      connected,
      TEXTS,
    );
    expect(plain.text).toBe('RO R');
    expect(plain).not.toHaveProperty('production');
  });
});
