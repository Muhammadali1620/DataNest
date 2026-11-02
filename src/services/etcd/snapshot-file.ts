// The file an etcd snapshot goes to (V13.35). It is written under a temporary name next to
// the target and takes the target's name only when the snapshot is whole, so a cancelled or
// failed snapshot never replaces an older backup with half a file. No `vscode`.

import { open, rename, rm } from 'node:fs/promises';
import type { SnapshotSink } from './etcd-cluster';

/** The name the file has while it is being written. */
export function partialName(path: string): string {
  return `${path}.part`;
}

export async function openSnapshotFile(path: string): Promise<SnapshotSink> {
  const partial = partialName(path);
  const handle = await open(partial, 'w');
  let closed = false;
  return {
    write: async (chunk) => {
      await handle.write(chunk);
    },
    close: async (keep) => {
      if (closed) {
        return;
      }
      closed = true;
      await handle.close();
      if (keep) {
        await rename(partial, path);
      } else {
        await rm(partial, { force: true });
      }
    },
  };
}
