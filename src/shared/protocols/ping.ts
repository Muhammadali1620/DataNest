// The diagnostic "ping" page: checks that the webview loads under our CSP and that
// RPC works in both directions. Not shown to users in production.
import { defineProtocol } from '../rpc';
import { number, object, string } from '../schema';

export const PING_MAX_TEXT_LENGTH = 1000;

const text = string({ maxLength: PING_MAX_TEXT_LENGTH });

export const pingProtocol = defineProtocol({
  host: {
    requests: {
      /** Webview → host: the host replies with the same text and a counter. */
      ping: {
        params: object({ text }),
        result: object({ reply: string(), count: number({ integer: true, min: 1 }) }),
      },
    },
    events: {
      /** The webview script has started and listens for messages. */
      ready: object({}),
    },
  },
  webview: {
    requests: {
      /** Host → webview: lets e2e tests check the opposite direction. */
      echo: { params: object({ text }), result: object({ text }) },
    },
    events: {
      /** Host → webview: a line to show on the page. */
      notice: object({ text }),
    },
  },
});

export type PingProtocol = typeof pingProtocol;
