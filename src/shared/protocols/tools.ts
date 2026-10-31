// The Tools page (V11.10): small utilities that need the host's help (hashes, network
// probes, saving a file). Everything else on the page runs in the page itself.

import { defineProtocol } from '../rpc';
import { array, boolean, type Infer, literal, number, object, optional, string } from '../schema';

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
        result: object({ items: array(interfaceSchema, { maxLength: 1000 }) }),
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
  webview: { requests: {}, events: {} },
});

export type ToolsProtocol = typeof toolsProtocol;
export type NetworkErrorCode = (typeof NETWORK_ERRORS)[number];
export type InterfaceInfo = Infer<typeof interfaceSchema>;
