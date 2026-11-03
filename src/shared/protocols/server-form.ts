// The form of a saved SSH server (V13.37): the window "New Server" opens, like the form of a
// new connection. Passwords travel only from the page to the host; a saved one is described
// by a flag (ARCHITECTURE.md §8).

import { CONNECTION_LIMITS } from '../connection';
import { sshServerInputSchema } from '../ssh-server';
import { defineProtocol } from '../rpc';
import { array, boolean, type Infer, number, object, optional, string } from '../schema';
import { passwordChangeSchema, serverChoiceSchema, sshSecretChangeSchema } from './connection-form';

/** What the page sends when testing or saving. */
const draftSchema = object({
  input: sshServerInputSchema,
  /** The secrets of the server's hops, jump hosts included; hops left out keep theirs. */
  ssh: array(sshSecretChangeSchema, { maxLength: 20 }),
  /** The password of the proxy; left out keeps the saved one. */
  proxyPassword: optional(passwordChangeSchema),
});

/** Everything the page needs to draw itself; the host sends it again on every load (D21). */
const formStateSchema = object({
  /** Absent when a new server is being made. */
  serverId: optional(string({ minLength: 1, maxLength: 100 })),
  /** What is saved; absent for a new server, whose form starts blank. */
  input: optional(sshServerInputSchema),
  /** Which hops have a saved password or passphrase; the values never travel. */
  storedSsh: array(
    object({
      hopId: string({ minLength: 1, maxLength: CONNECTION_LIMITS.hopId }),
      password: boolean(),
      passphrase: boolean(),
    }),
    { maxLength: 20 },
  ),
  hasStoredProxyPassword: optional(boolean()),
  /** The other saved servers a jump host can be filled from (V15.4); never the edited one. */
  servers: optional(array(serverChoiceSchema, { maxLength: 1000 })),
});

export const serverFormProtocol = defineProtocol({
  host: {
    requests: {
      /** Logs in with these settings and opens SFTP without saving anything. */
      test: {
        params: draftSchema,
        result: object({
          /** The login folder the server answered with. */
          home: string({ maxLength: 4096 }),
          /** How many SSH servers the way leads through, the server itself included. */
          hops: number({ integer: true, min: 1, max: 20 }),
        }),
      },
      /** Saves a new server or updates the one being edited. */
      save: { params: draftSchema, result: object({ serverId: string() }) },
      /** Shows the editor's file dialog for a private key; the result is its path. */
      pickKeyFile: {
        params: object({}),
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

export type ServerFormProtocol = typeof serverFormProtocol;

export type ServerFormState = Infer<typeof formStateSchema>;

export type ServerDraft = Infer<typeof draftSchema>;
