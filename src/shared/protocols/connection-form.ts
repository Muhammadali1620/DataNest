// The connection form: the only page that may carry a password, and only from the
// webview to the host. A stored password is never sent back to the page — it is
// described by a flag instead (ARCHITECTURE.md §8).

import { CONNECTION_LIMITS, DRIVER_IDS, type ConnectionInput } from '../connection';
import { defineProtocol } from '../rpc';
import {
  array,
  boolean,
  type Infer,
  literal,
  number,
  object,
  optional,
  type Schema,
  string,
} from '../schema';

export const PASSWORD_MAX_LENGTH = 1000;

/** The editable fields, exactly as the form sends them. */
export const connectionInputSchema: Schema<ConnectionInput> = object({
  name: string({ maxLength: CONNECTION_LIMITS.name }),
  driver: literal(...DRIVER_IDS),
  host: optional(string({ maxLength: CONNECTION_LIMITS.field })),
  port: optional(number({ integer: true, min: 1, max: 65_535 })),
  user: optional(string({ maxLength: CONNECTION_LIMITS.field })),
  database: optional(string({ maxLength: CONNECTION_LIMITS.field })),
  file: optional(string({ maxLength: CONNECTION_LIMITS.file })),
});

/**
 * What the form says about the password: leave the stored one alone, replace it,
 * or erase it. `keep` is the only option when editing without touching the field.
 */
export const passwordChangeSchema = object({
  kind: literal('keep', 'set', 'clear'),
  value: optional(string({ maxLength: PASSWORD_MAX_LENGTH })),
});

const draftSchema = object({
  input: connectionInputSchema,
  password: passwordChangeSchema,
});

/** Everything the page needs to render itself; the host re-sends it on every load (D21). */
const formStateSchema = object({
  /** Absent when creating a new connection. */
  connectionId: optional(string({ minLength: 1, maxLength: 100 })),
  input: connectionInputSchema,
  /** True when a password is stored for this connection. The value never travels. */
  hasStoredPassword: boolean(),
  /** Driver ids the page may offer, with their default ports. */
  drivers: array(
    object({
      id: literal(...DRIVER_IDS),
      defaultPort: optional(number({ integer: true, min: 1, max: 65_535 })),
      /** The driver opens a local file instead of a network connection. */
      file: boolean(),
    }),
    { maxLength: 100 },
  ),
});

export const connectionFormProtocol = defineProtocol({
  host: {
    requests: {
      /** Opens the connection with these settings without saving them. */
      test: { params: draftSchema, result: object({}) },
      /** Saves a new connection or updates the one being edited. */
      save: { params: draftSchema, result: object({ connectionId: string() }) },
      /** Shows the editor's file dialog; the result is the chosen path, if any. */
      pickFile: {
        params: object({ create: boolean() }),
        result: object({ file: optional(string({ maxLength: CONNECTION_LIMITS.file })) }),
      },
    },
    events: {
      /** The page script has started and listens for messages. */
      ready: object({}),
      /** The user pressed Cancel; the host closes the panel. */
      close: object({}),
    },
  },
  webview: {
    requests: {},
    events: {
      /** Host → page: the whole form state, on load and after a save. */
      state: formStateSchema,
    },
  },
});

export type ConnectionFormProtocol = typeof connectionFormProtocol;

/** What the page renders; built by the host, validated on arrival. */
export type ConnectionFormState = Infer<typeof formStateSchema>;

/** What the page sends when testing or saving. */
export type ConnectionDraft = Infer<typeof draftSchema>;

export type PasswordChangeMessage = Infer<typeof passwordChangeSchema>;
