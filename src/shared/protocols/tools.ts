// The Tools page (V11.10): small utilities that need the host's help (hashes, network
// probes, saving a file). Everything else on the page runs in the page itself.

import { defineProtocol } from '../rpc';
import {
  array,
  boolean,
  type Infer,
  literal,
  number,
  object,
  optional,
  string,
  union,
} from '../schema';
import { DNS_TYPES, DOH_PROVIDERS } from '../tools/doh';
import { SETTING_GROUPS } from '../tools/settings-map';
import { MAX_TINY_BASE64, TINY_ERRORS, TINY_MIMES } from '../tools/tinypng';

/** The longest text a hash is asked for: five million characters. */
export const MAX_HASH_TEXT = 5_000_000;
/** The largest file the page may ask the host to save, as Base64 (about 16 MB of bytes). */
export const MAX_SAVE_BASE64 = 22_000_000;

const hostText = string({ minLength: 1, maxLength: 1000 });
const port = number({ integer: true, min: 1, max: 65_535 });
const timeout = number({ integer: true, min: 1, max: 600_000 });

/** Why a probe or a lookup did not work, in a few words the page can translate. */
export const NETWORK_ERRORS = [
  'invalid-host',
  'invalid-port',
  'refused',
  'timeout',
  'unreachable',
  'not-found',
  'failed',
] as const;
const networkError = literal(...NETWORK_ERRORS);

export const interfaceSchema = object({
  name: string({ maxLength: 200 }),
  address: string({ maxLength: 100 }),
  family: literal('IPv4', 'IPv6'),
  mac: string({ maxLength: 50 }),
  internal: boolean(),
  cidr: optional(string({ maxLength: 120 })),
});

/** What a setting holds: the page shows toggles, choices, numbers and short texts. */
const settingValue = union(string({ maxLength: 300 }), number(), boolean());

export const processSchema = object({
  pid: number({ integer: true, min: 0 }),
  name: string({ maxLength: 300 }),
  user: string({ maxLength: 200 }),
  cpu: optional(number({ min: 0 })),
  cpuMs: optional(number({ min: 0 })),
  memoryKb: optional(number({ min: 0 })),
  runtimeSec: optional(number({ min: 0 })),
  command: string({ maxLength: 2000 }),
});

export const settingItemSchema = object({
  id: string({ maxLength: 120 }),
  kind: literal('boolean', 'choice', 'number', 'text'),
  label: string({ maxLength: 300 }),
  description: string({ maxLength: 2000 }),
  value: settingValue,
  default: settingValue,
  choices: optional(
    array(object({ value: string({ maxLength: 100 }), label: string({ maxLength: 100 }) }), {
      maxLength: 50,
    }),
  ),
  min: optional(number()),
  max: optional(number()),
  integer: optional(boolean()),
});

export const settingGroupSchema = object({
  id: literal(...SETTING_GROUPS),
  items: array(settingItemSchema, { maxLength: 100 }),
});

/** The buttons of the settings tab that do something in the editor. */
export const TOOLS_ACTIONS = [
  'exportConnections',
  'importConnections',
  'closeConnections',
  'clearCache',
  'reportIssue',
] as const;

const dnsType = literal(...DNS_TYPES);
const dohProvider = literal(...DOH_PROVIDERS);

export const toolsProtocol = defineProtocol({
  host: {
    requests: {
      /** MD5, SHA-1 and SHA-256 of a text (as UTF-8), and its size in bytes. */
      hash: {
        params: object({ text: string({ maxLength: MAX_HASH_TEXT }) }),
        result: object({
          md5: string({ maxLength: 64 }),
          sha1: string({ maxLength: 64 }),
          sha256: string({ maxLength: 64 }),
          bytes: number({ integer: true, min: 0 }),
        }),
      },
      /** The clipboard's text, for a paste a webview may not read itself. */
      clipboardText: {
        params: object({}),
        result: object({ text: string({ maxLength: 20_000_000 }) }),
      },
      /** The network interfaces of this machine. */
      interfaces: {
        params: object({}),
        result: object({
          items: array(interfaceSchema, { maxLength: 1000 }),
          hostname: optional(string({ maxLength: 300 })),
        }),
      },
      /** Opens a TCP connection and closes it again. */
      portCheck: {
        params: object({ host: hostText, port, timeoutMs: timeout }),
        result: object({
          open: boolean(),
          ms: optional(number({ min: 0 })),
          error: optional(networkError),
        }),
      },
      /** Resolves a name to its addresses through the system resolver. */
      dnsLookup: {
        params: object({ host: hostText }),
        result: object({
          addresses: array(object({ address: string({ maxLength: 100 }), family: literal(4, 6) }), {
            maxLength: 200,
          }),
          error: optional(networkError),
        }),
      },
      /** Several TCP connects in a row, one after another; not ICMP. */
      tcpPing: {
        params: object({
          host: hostText,
          port,
          count: number({ integer: true, min: 1, max: 100 }),
          timeoutMs: timeout,
        }),
        result: object({
          attempts: array(
            object({
              ok: boolean(),
              ms: optional(number({ min: 0 })),
              error: optional(networkError),
            }),
            {
              maxLength: 100,
            },
          ),
          error: optional(networkError),
        }),
      },
      /**
       * The address the internet sees, from api.ipify.org (IPv4) and api6.ipify.org (IPv6).
       * Asked only when the user presses the button.
       */
      publicIp: {
        params: object({}),
        result: object({
          ipv4: optional(string({ maxLength: 50 })),
          ipv6: optional(string({ maxLength: 60 })),
          error: optional(networkError),
        }),
      },
      /** A DNS question over HTTPS to Cloudflare or Google; only on the user's click. */
      dohLookup: {
        params: object({ host: hostText, type: dnsType, provider: dohProvider }),
        result: object({
          records: array(
            object({
              name: string({ maxLength: 300 }),
              type: string({ maxLength: 10 }),
              ttl: number({ min: 0 }),
              data: string({ maxLength: 2000 }),
            }),
            { maxLength: 200 },
          ),
          error: optional(networkError),
        }),
      },
      /**
       * ICMP ping through the system's `ping`. The lines arrive as `pingLine` events with
       * the same `runId`; `available: false` means the program is not on this machine.
       */
      icmpPing: {
        params: object({
          runId: number({ integer: true, min: 0 }),
          host: hostText,
          count: number({ integer: true, min: 1, max: 100 }),
          timeoutMs: timeout,
          resolve: literal('direct', 'doh'),
          provider: dohProvider,
        }),
        result: object({
          available: boolean(),
          attempts: array(object({ ok: boolean(), ms: optional(number({ min: 0 })) }), {
            maxLength: 100,
          }),
          /** The address the name was resolved to over HTTPS, when the user chose that. */
          resolved: optional(string({ maxLength: 100 })),
          error: optional(networkError),
        }),
      },
      /** Stops a running ping. */
      icmpCancel: {
        params: object({ runId: number({ integer: true, min: 0 }) }),
        result: object({}),
      },
      /** The processes of this machine. */
      processes: {
        params: object({}),
        result: object({
          platform: string({ maxLength: 20 }),
          currentUser: string({ maxLength: 200 }),
          items: array(processSchema, { maxLength: 6000 }),
          truncated: boolean(),
          error: optional(literal('failed')),
        }),
      },
      /** Asks the user to confirm, then ends the process (`force`: without letting it clean up). */
      killProcess: {
        params: object({
          pid: number({ integer: true, min: 0 }),
          name: string({ maxLength: 300 }),
          force: boolean(),
        }),
        result: object({
          ok: boolean(),
          error: optional(
            literal('cancelled', 'invalid-pid', 'protected', 'denied', 'not-found', 'failed'),
          ),
        }),
      },
      /** The extension's own settings the page shows, with their current values. */
      settingsList: {
        params: object({}),
        result: object({ groups: array(settingGroupSchema, { maxLength: 20 }) }),
      },
      settingsSet: {
        params: object({ id: string({ maxLength: 120 }), value: settingValue }),
        result: object({ ok: boolean() }),
      },
      /** Back to the default for these settings. */
      settingsReset: {
        params: object({ ids: array(string({ maxLength: 120 }), { maxLength: 100 }) }),
        result: object({ ok: boolean() }),
      },
      /** A button of the settings tab that acts in the editor. */
      runAction: {
        params: object({ action: literal(...TOOLS_ACTIONS) }),
        result: object({ ok: boolean() }),
      },
      /** Whether a TinyPNG key is stored; the key itself never leaves the host. */
      tinyStatus: { params: object({}), result: object({ saved: boolean() }) },
      tinySaveKey: {
        params: object({ key: string({ maxLength: 300 }) }),
        result: object({ ok: boolean(), error: optional(literal('invalid')) }),
      },
      tinyForgetKey: { params: object({}), result: object({ ok: boolean() }) },
      /** Sends a picture to TinyPNG with the stored key; only when the user presses Compress. */
      tinyCompress: {
        params: object({
          base64: string({ maxLength: MAX_TINY_BASE64 }),
          mime: literal(...TINY_MIMES),
        }),
        result: object({
          ok: boolean(),
          base64: optional(string({ maxLength: MAX_SAVE_BASE64 })),
          count: optional(number({ integer: true, min: 0 })),
          error: optional(literal(...TINY_ERRORS)),
        }),
      },
      /** Opens a link read from a QR code, after asking the user. */
      openLink: {
        params: object({ url: string({ minLength: 1, maxLength: 2000 }) }),
        result: object({ opened: boolean() }),
      },
      /** Asks where to save, then writes the bytes (Base64) there. */
      saveFile: {
        params: object({
          suggestedName: string({ minLength: 1, maxLength: 200 }),
          /** The extension without a dot, for the dialog's filter. */
          extension: string({ minLength: 1, maxLength: 10 }),
          base64: string({ maxLength: MAX_SAVE_BASE64 }),
        }),
        result: object({
          ok: boolean(),
          error: optional(literal('cancelled', 'failed', 'invalid')),
        }),
      },
    },
    events: {
      /** The page script has started and listens for messages. */
      ready: object({}),
      /** Put this on the clipboard; a webview may not write it itself. */
      copyText: object({ text: string({ maxLength: 1_000_000 }) }),
    },
  },
  webview: {
    requests: {},
    events: {
      /** A line printed by a running ping. */
      pingLine: object({
        runId: number({ integer: true, min: 0 }),
        text: string({ maxLength: 1000 }),
        reply: boolean(),
        ms: optional(number({ min: 0 })),
      }),
      /** A setting changed in the editor's own settings. */
      settingsChanged: object({ groups: array(settingGroupSchema, { maxLength: 20 }) }),
    },
  },
});

export type ToolsProtocol = typeof toolsProtocol;
export type NetworkErrorCode = (typeof NETWORK_ERRORS)[number];
export type InterfaceInfo = Infer<typeof interfaceSchema>;
export type ToolsAction = (typeof TOOLS_ACTIONS)[number];
export type { ProcessInfo } from '../tools/processes';
