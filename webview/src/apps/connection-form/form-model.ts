// Pure form logic: what the user typed → what the host receives, and which
// problems block saving. Kept apart from the component so it is tested directly.

import {
  type ConnectionInput,
  type ConnectionProblem,
  connectionProblems,
  type DriverId,
  isFileDriver,
} from '../../../../src/shared/connection';
import type {
  ConnectionDraft,
  ConnectionFormState,
} from '../../../../src/shared/protocols/connection-form';
import type { MessageKey } from '../../l10n/en';

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
  };
}

/** A port is kept only when it is written as a plain number. */
export function parsePort(text: string): number | undefined {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}

/** Only the fields that apply to the chosen driver are sent; blanks are dropped. */
export function toInput(fields: FormFields): ConnectionInput {
  const trim = (value: string): string | undefined => {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  };
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
  };
}

/**
 * What to do with the password. Typing replaces it, the erase box clears it, and
 * leaving an untouched box alone keeps whatever is stored.
 */
export function passwordChange(fields: FormFields): ConnectionDraft['password'] {
  if (fields.erasePassword) {
    return { kind: 'clear' };
  }
  if (fields.passwordTouched) {
    return fields.password === '' ? { kind: 'clear' } : { kind: 'set', value: fields.password };
  }
  return { kind: 'keep' };
}

export function toDraft(fields: FormFields): ConnectionDraft {
  return { input: toInput(fields), password: passwordChange(fields) };
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
  return problems;
}

/** Message key per problem, so the form shows a translated line. */
export const PROBLEM_MESSAGES: Readonly<Record<ConnectionProblem, MessageKey>> = {
  'name-empty': 'form.error.nameEmpty',
  'host-empty': 'form.error.hostEmpty',
  'port-invalid': 'form.error.portInvalid',
  'file-empty': 'form.error.fileEmpty',
};

export function problemMessage(
  problems: readonly ConnectionProblem[],
  problem: ConnectionProblem,
): MessageKey | undefined {
  return problems.includes(problem) ? PROBLEM_MESSAGES[problem] : undefined;
}
