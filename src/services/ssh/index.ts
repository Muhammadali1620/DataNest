// The SSH bundle (dist/ssh.js): ssh2 is loaded only when the first connection
// through an SSH tunnel opens (ARCHITECTURE.md §7).

import type { SshModule } from '../tunnels';
import { openSshTunnel } from './tunnel';

export const ssh: SshModule = { openTunnel: openSshTunnel };
