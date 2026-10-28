// Tunnels that only record what they were asked for, so services that use SSH are
// tested without ssh2 (the real tunnel has its own tests).

import { DbError } from '../../src/core/errors';
import type { TunnelProvider } from '../../src/services/connection-manager';
import type { Tunnel, TunnelLease, TunnelSpec } from '../../src/services/tunnels';

export class FakeTunnel implements Tunnel {
  closeCount = 0;
  failure: DbError | undefined;
  private resolveClosed: () => void = () => undefined;
  readonly closed = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });

  constructor(
    readonly port: number,
    readonly spec: TunnelSpec,
  ) {}

  forwardError(): DbError | undefined {
    return this.failure;
  }

  close(): Promise<void> {
    this.closeCount += 1;
    this.resolveClosed();
    return Promise.resolve();
  }
}

export class FakeTunnels implements TunnelProvider {
  readonly acquired: { key: string; spec: TunnelSpec }[] = [];
  readonly released: string[] = [];
  readonly privates: FakeTunnel[] = [];
  openError: Error | undefined;
  /** Set on every lease handed out from now on. */
  forwardFailure: DbError | undefined;
  private nextPort = 40_000;

  acquire(key: string, spec: TunnelSpec): Promise<TunnelLease> {
    this.acquired.push({ key, spec });
    if (this.openError !== undefined) {
      return Promise.reject(this.openError);
    }
    const port = this.nextPort++;
    const failure = this.forwardFailure;
    let released = false;
    return Promise.resolve({
      port,
      forwardError: () => failure,
      release: () => {
        if (!released) {
          released = true;
          this.released.push(key);
        }
        return Promise.resolve();
      },
    });
  }

  openPrivate(spec: TunnelSpec): Promise<Tunnel> {
    if (this.openError !== undefined) {
      return Promise.reject(this.openError);
    }
    const tunnel = new FakeTunnel(this.nextPort++, spec);
    tunnel.failure = this.forwardFailure;
    this.privates.push(tunnel);
    return Promise.resolve(tunnel);
  }
}

export function unreachable(): DbError {
  return new DbError('connection-failed', 'The SSH server bastion cannot reach db:3306');
}
