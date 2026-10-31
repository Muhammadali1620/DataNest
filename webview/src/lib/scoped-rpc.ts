// The Manager page hosts pages that were written for a peer of their own (the server
// monitor, the schema comparison). Their protocols ride on the Manager's under a prefix,
// and this gives each hosted page a peer that adds and removes it.

import type { RpcPeer, SideSpec } from '../../../src/shared/rpc';

interface LoosePeer {
  request(method: string, params: unknown): Promise<unknown>;
  on(event: string, listener: (payload: unknown) => void): { dispose(): void };
  emit(event: string, payload: unknown): void;
}

/** A peer that speaks `prefix.name` on the real peer where the page says `name`. */
export function scopedRpc<Local extends SideSpec, Remote extends SideSpec>(
  peer: unknown,
  prefix: string,
): RpcPeer<Local, Remote> {
  const real = peer as LoosePeer;
  const scoped = {
    request: async (method: string, params: unknown) =>
      await real.request(`${prefix}.${method}`, params),
    on: (event: string, listener: (payload: unknown) => void) =>
      real.on(`${prefix}.${event}`, listener),
    emit: (event: string, payload: unknown) => {
      real.emit(`${prefix}.${event}`, payload);
    },
    dispose: () => undefined,
  };
  return scoped as unknown as RpcPeer<Local, Remote>;
}
