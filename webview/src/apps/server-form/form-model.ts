// What the server form holds and how it becomes what is sent (V13.37). The SSH login and the
// jump hosts are the hop fields of the connection form, so a hop is edited, checked and
// saved the same way in both places.

import {
  type ConnectionColor,
  DEFAULT_PROXY_PORTS,
  type ProxyKind,
  type ProxySettings,
} from '../../../../src/shared/connection';
import type { ServerDraft, ServerFormState } from '../../../../src/shared/protocols/server-form';
import {
  type ServerProblem,
  serverProblems,
  type SshServerInput,
} from '../../../../src/shared/ssh-server';
import type { MessageKey } from '../../l10n/en';
import {
  emptySecret,
  type HopFields,
  hopFieldsFrom,
  hopProblemsOf,
  hopSecretChanges,
  newHopFields,
  parsePort,
  PROBLEM_MESSAGES,
  secretChange,
  type SecretField,
  toHop,
} from '../connection-form/form-model';

/** Everything the form holds; ports stay text while the user types. */
export interface ServerFields {
  name: string;
  color: '' | ConnectionColor;
  startPath: string;
  readOnly: boolean;
  /** The server itself: the last hop. */
  ssh: HopFields;
  /** Logged in to first, in this order. */
  jumps: HopFields[];
  useProxy: boolean;
  proxyKind: ProxyKind;
  proxyHost: string;
  proxyPort: string;
  proxyUser: string;
  proxyPassword: SecretField;
}

/** What a blank form starts with. */
export function newServerFields(): ServerFields {
  return {
    name: '',
    color: '',
    startPath: '',
    readOnly: false,
    ssh: newHopFields(),
    jumps: [],
    useProxy: false,
    proxyKind: 'socks5',
    proxyHost: '',
    proxyPort: String(DEFAULT_PROXY_PORTS.socks5),
    proxyUser: '',
    proxyPassword: emptySecret(),
  };
}

/** The fields of a saved server, or blank ones when the state carries none. */
export function fieldsFrom(state: ServerFormState): ServerFields {
  const { input } = state;
  if (input === undefined) {
    return newServerFields();
  }
  return {
    name: input.name,
    color: input.color ?? '',
    startPath: input.startPath ?? '',
    readOnly: input.readOnly === true,
    ssh: hopFieldsFrom(input.ssh),
    jumps: (input.ssh.jumps ?? []).map((jump) => hopFieldsFrom(jump)),
    useProxy: input.proxy !== undefined,
    proxyKind: input.proxy?.kind ?? 'socks5',
    proxyHost: input.proxy?.host ?? '',
    proxyPort: String(input.proxy?.port ?? DEFAULT_PROXY_PORTS[input.proxy?.kind ?? 'socks5']),
    proxyUser: input.proxy?.user ?? '',
    proxyPassword: emptySecret(),
  };
}

function trimmed(value: string): string | undefined {
  const text = value.trim();
  return text === '' ? undefined : text;
}

/** The proxy to send, when one is on. */
export function toProxy(fields: ServerFields): ProxySettings | undefined {
  if (!fields.useProxy) {
    return undefined;
  }
  const typed = parsePort(fields.proxyPort);
  const port = typed === DEFAULT_PROXY_PORTS[fields.proxyKind] ? undefined : typed;
  const user = trimmed(fields.proxyUser);
  return {
    kind: fields.proxyKind,
    host: fields.proxyHost.trim(),
    ...(port === undefined ? {} : { port }),
    ...(user === undefined ? {} : { user }),
  };
}

/** The server as the model has it; blank optional fields are left out. */
export function toInput(fields: ServerFields): SshServerInput {
  const proxy = toProxy(fields);
  const startPath = trimmed(fields.startPath);
  return {
    name: fields.name.trim(),
    ssh: {
      ...toHop(fields.ssh),
      ...(fields.jumps.length === 0 ? {} : { jumps: fields.jumps.map((jump) => toHop(jump)) }),
    },
    ...(proxy === undefined ? {} : { proxy }),
    ...(startPath === undefined ? {} : { startPath }),
    ...(fields.readOnly ? { readOnly: true } : {}),
    ...(fields.color === '' ? {} : { color: fields.color }),
  };
}

/** What Test and Save send: the server and what to do with every secret. */
export function toDraft(fields: ServerFields): ServerDraft {
  return {
    input: toInput(fields),
    ssh: [...fields.jumps, fields.ssh].map((hop) => hopSecretChanges(hop)),
    // Without a proxy the store drops its password by itself.
    ...(fields.useProxy ? { proxyPassword: secretChange(fields.proxyPassword) } : {}),
  };
}

/** Problems that block Test and Save; empty means the form is ready. */
export function problemsOf(fields: ServerFields): ServerProblem[] {
  const problems = serverProblems(toInput(fields));
  // A port that is not a plain number never reaches the model, so the text is checked too.
  for (const hop of [...fields.jumps, fields.ssh]) {
    for (const problem of hopProblemsOf(hop)) {
      if (!problems.includes(problem)) {
        problems.push(problem);
      }
    }
  }
  const proxyPort = fields.proxyPort.trim();
  if (
    fields.useProxy &&
    proxyPort !== '' &&
    parsePort(proxyPort) === undefined &&
    !problems.includes('proxy-port-invalid')
  ) {
    problems.push('proxy-port-invalid');
  }
  return problems;
}

/** The line shown under a field for each problem. */
export const SERVER_PROBLEM_MESSAGES: Readonly<Record<ServerProblem, MessageKey>> = {
  'name-empty': 'serverForm.error.nameEmpty',
  'too-long': 'serverForm.error.tooLong',
  'ssh-host-empty': PROBLEM_MESSAGES['ssh-host-empty'],
  'ssh-port-invalid': PROBLEM_MESSAGES['ssh-port-invalid'],
  'ssh-user-empty': PROBLEM_MESSAGES['ssh-user-empty'],
  'ssh-key-empty': PROBLEM_MESSAGES['ssh-key-empty'],
  'ssh-id-invalid': PROBLEM_MESSAGES['ssh-id-invalid'],
  'ssh-too-many-jumps': PROBLEM_MESSAGES['ssh-too-many-jumps'],
  'ssh-algorithms-invalid': PROBLEM_MESSAGES['ssh-algorithms-invalid'],
  'proxy-host-empty': PROBLEM_MESSAGES['proxy-host-empty'],
  'proxy-port-invalid': PROBLEM_MESSAGES['proxy-port-invalid'],
};

export { moveJump, newHopFields, proxyPortAfterKind } from '../connection-form/form-model';
