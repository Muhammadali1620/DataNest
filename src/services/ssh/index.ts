// The SSH bundle (dist/ssh.js): ssh2 is loaded only when the first connection
// through an SSH tunnel opens (ARCHITECTURE.md §7).

import type { SshModule } from '../tunnels';
import { downloadFiles } from './sftp';
import { openSftpSession } from './sftp-session';
import { execRemoteCommand, openExecChannel, openShellSession } from './shell-session';
import { openSshTunnel } from './tunnel';

export const ssh: SshModule = {
  openTunnel: openSshTunnel,
  downloadFiles,
  openSftp: openSftpSession,
  openShell: openShellSession,
  execCommand: execRemoteCommand,
  openExec: openExecChannel,
};
