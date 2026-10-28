// Pure form logic: what the user typed → what the host receives, and which
// problems block saving. Kept apart from the component so it is tested directly.

import {
  type ConnectionInput,
  type ConnectionProblem,
  connectionProblems,
  DEFAULT_SSH_PORT,
  type DriverId,
  isFileDriver,
  newHopId,
  type SshAuthMethod,
  type SshHop,
  type SshProblem,
  sshHopProblems,
} from '../../../../src/shared/connection';
import type {
  ConnectionDraft,
  ConnectionFormState,
} from '../../../../src/shared/protocols/connection-form';
import type { MessageKey } from '../../l10n/en';

/** A secret box: what was typed, whether it was, and whether to erase the stored one. */
export interface SecretField {
  value: string;
  touched: boolean;
  erase: boolean;
}

export function emptySecret(): SecretField {
  return { value: '', touched: false, erase: false };
}

/** One SSH server as the form edits it. */
export interface HopFields {
  id: string;
  host: string;
  port: string;
  user: string;
  auth: SshAuthMethod;
  keyFile: string;
  agentSocket: string;
  password: SecretField;
  passphrase: SecretField;
}

export function newHopFields(id: string = newHopId()): HopFields {
  return {
    id,
    host: '',
    port: '',
    user: '',
    auth: 'password',
    keyFile: '',
    agentSocket: '',
    password: emptySecret(),
    passphrase: emptySecret(),
  };
}

export function hopFieldsFrom(hop: SshHop): HopFields {
  return {
    id: hop.id,
    host: hop.host,
    port: hop.port === undefined ? '' : String(hop.port),
    user: hop.user,
    auth: hop.auth,
    keyFile: hop.keyFile ?? '',
    agentSocket: hop.agentSocket ?? '',
    password: emptySecret(),
    passphrase: emptySecret(),
  };
}

/** Everything the form holds; ports stay text while the user types. */
export interface FormFields {
  name: string;
  driver: DriverId;
  host: string;
  port: string;
  user: string;
  database: string;
  file: string;
  /** What the user typed into the password box. */
  password: string;
  /** True once the user edited the password box. */
  passwordTouched: boolean;
  /** The user asked to erase the stored password. */
  erasePassword: boolean;
  /** Connect through an SSH server. */
  useSsh: boolean;
  /** Kept while SSH is off, so turning it back on restores what was typed. */
  ssh: HopFields;
}

export function fieldsFrom(state: ConnectionFormState): FormFields {
  const { input } = state;
  return {
    name: input.name,
    driver: input.driver,
    host: input.host ?? '',
    port: input.port === undefined ? '' : String(input.port),
    user: input.user ?? '',
    database: input.database ?? '',
    file: input.file ?? '',
    password: '',
    passwordTouched: false,
    erasePassword: false,
    useSsh: input.ssh !== undefined,
    ssh: input.ssh === undefined ? newHopFields() : hopFieldsFrom(input.ssh),
  };
}

/** A port is kept only when it is written as a plain number. */
export function parsePort(text: string): number | undefined {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}

function trim(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** The hop as the model has it; a port that is not a number is left out (and flagged). */
export function toHop(hop: HopFields): SshHop {
  const port = parsePort(hop.port);
  const keyFile = hop.auth === 'key' ? trim(hop.keyFile) : undefined;
  const agentSocket = hop.auth === 'agent' ? trim(hop.agentSocket) : undefined;
  return {
    id: hop.id,
    host: hop.host.trim(),
    ...(port === undefined ? {} : { port }),
    user: hop.user.trim(),
    auth: hop.auth,
    ...(keyFile === undefined ? {} : { keyFile }),
    ...(agentSocket === undefined ? {} : { agentSocket }),
  };
}

/** Only the fields that apply to the chosen driver are sent; blanks are dropped. */
export function toInput(fields: FormFields): ConnectionInput {
  const name = fields.name.trim();
  if (isFileDriver(fields.driver)) {
    const file = trim(fields.file);
    return { name, driver: fields.driver, ...(file === undefined ? {} : { file }) };
  }
  const host = trim(fields.host);
  const port = parsePort(fields.port);
  const user = trim(fields.user);
  const database = trim(fields.database);
  return {
    name,
    driver: fields.driver,
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(user === undefined ? {} : { user }),
    ...(database === undefined ? {} : { database }),
    ...(fields.useSsh ? { ssh: toHop(fields.ssh) } : {}),
  };
}

type SecretChange = ConnectionDraft['password'];

/**
 * What to do with a secret. Typing replaces it, the erase box clears it, and
 * leaving an untouched box alone keeps whatever is stored.
 */
export function secretChange(secret: SecretField): SecretChange {
  if (secret.erase) {
    return { kind: 'clear' };
  }
  if (secret.touched) {
    return secret.value === '' ? { kind: 'clear' } : { kind: 'set', value: secret.value };
  }
  return { kind: 'keep' };
}

export function passwordChange(fields: FormFields): SecretChange {
  return secretChange({
    value: fields.password,
    touched: fields.passwordTouched,
    erase: fields.erasePassword,
  });
}

/** A secret the hop's method does not use is erased, so a stale one is not kept. */
export function hopSecretChanges(hop: HopFields): NonNullable<ConnectionDraft['ssh']>[number] {
  return {
    hopId: hop.id,
    password: hop.auth === 'password' ? secretChange(hop.password) : { kind: 'clear' },
    passphrase: hop.auth === 'key' ? secretChange(hop.passphrase) : { kind: 'clear' },
  };
}

export function toDraft(fields: FormFields): ConnectionDraft {
  const input = toInput(fields);
  return {
    input,
    password: passwordChange(fields),
    ...(input.ssh === undefined ? {} : { ssh: [hopSecretChanges(fields.ssh)] }),
  };
}

/** Problems of one hop, including a port that is not a plain number. */
export function hopProblemsOf(hop: HopFields): SshProblem[] {
  const problems = sshHopProblems(toHop(hop));
  const port = hop.port.trim();
  if (port !== '' && parsePort(port) === undefined && !problems.includes('ssh-port-invalid')) {
    problems.push('ssh-port-invalid');
  }
  return problems;
}

/** Problems that block Test and Save; empty means the form is ready. */
export function problemsOf(fields: FormFields): ConnectionProblem[] {
  const problems = connectionProblems(toInput(fields));
  // A port that is not a plain number never reaches the model, so check the text.
  const port = fields.port.trim();
  if (
    !isFileDriver(fields.driver) &&
    port !== '' &&
    parsePort(port) === undefined &&
    !problems.includes('port-invalid')
  ) {
    problems.push('port-invalid');
  }
  if (!isFileDriver(fields.driver) && fields.useSsh) {
    for (const problem of hopProblemsOf(fields.ssh)) {
      if (!problems.includes(problem)) {
        problems.push(problem);
      }
    }
  }
  return problems;
}

/** Message key per problem, so the form shows a translated line. */
export const PROBLEM_MESSAGES: Readonly<Record<ConnectionProblem, MessageKey>> = {
  'name-empty': 'form.error.nameEmpty',
  'host-empty': 'form.error.hostEmpty',
  'port-invalid': 'form.error.portInvalid',
  'file-empty': 'form.error.fileEmpty',
  'ssh-host-empty': 'form.error.hostEmpty',
  'ssh-port-invalid': 'form.error.portInvalid',
  'ssh-user-empty': 'form.ssh.error.userEmpty',
  'ssh-key-empty': 'form.ssh.error.keyEmpty',
  'ssh-id-invalid': 'form.unknownError',
};

export { DEFAULT_SSH_PORT };

export function problemMessage(
  problems: readonly ConnectionProblem[],
  problem: ConnectionProblem,
): MessageKey | undefined {
  return problems.includes(problem) ? PROBLEM_MESSAGES[problem] : undefined;
}
