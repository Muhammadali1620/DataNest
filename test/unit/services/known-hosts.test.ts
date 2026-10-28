import { describe, expect, it } from 'vitest';
import { KNOWN_HOSTS_STATE_KEY, KnownHosts } from '../../../src/services/known-hosts';
import type { HostKeyInfo } from '../../../src/services/tunnels';
import { FakeMemento, RecordingLogger } from '../../helpers/fakes';

const key: HostKeyInfo = {
  host: 'bastion.example',
  port: 22,
  algorithm: 'ssh-ed25519',
  fingerprint: 'SHA256:aaa',
};

describe('KnownHosts', () => {
  it('knows nothing at first, then trusts what was trusted', async () => {
    const state = new FakeMemento();
    const known = new KnownHosts(state, new RecordingLogger());
    expect(known.status(key)).toBe('unknown');
    await known.trust(key);
    expect(known.status(key)).toBe('trusted');
    expect(new KnownHosts(state, new RecordingLogger()).status(key)).toBe('trusted');
  });

  it('flags a changed key and remembers the old one', async () => {
    const known = new KnownHosts(new FakeMemento(), new RecordingLogger());
    await known.trust(key);
    const changed = { ...key, fingerprint: 'SHA256:bbb' };
    expect(known.status(changed)).toBe('changed');
    expect(known.previous(changed)).toBe('SHA256:aaa');
    await known.trust(changed);
    expect(known.status(changed)).toBe('trusted');
    expect(known.status(key)).toBe('changed');
  });

  it('matches host names without case, but not other ports or key types', async () => {
    const known = new KnownHosts(new FakeMemento(), new RecordingLogger());
    await known.trust(key);
    expect(known.status({ ...key, host: 'BASTION.example' })).toBe('trusted');
    expect(known.status({ ...key, port: 2222 })).toBe('unknown');
    expect(known.status({ ...key, algorithm: 'rsa-sha2-512' })).toBe('unknown');
    expect(known.previous({ ...key, port: 2222 })).toBeUndefined();
  });

  it('ignores corrupted state loudly instead of trusting anything', () => {
    const state = new FakeMemento(new Map([[KNOWN_HOSTS_STATE_KEY, { version: 1, items: [{}] }]]));
    const logger = new RecordingLogger();
    const known = new KnownHosts(state, logger);
    expect(known.status(key)).toBe('unknown');
    expect(logger.entries.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('stores entries in a versioned shape', async () => {
    const state = new FakeMemento();
    await new KnownHosts(state, new RecordingLogger()).trust(key);
    expect(state.get(KNOWN_HOSTS_STATE_KEY)).toEqual({ version: 1, items: [key] });
  });
});
