import type { RpcSubscription, RpcTransport } from '../../../src/shared/rpc';

/** The object VS Code injects into webviews; it can be acquired only once per page. */
export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  api ??= acquireVsCodeApi();
  return api;
}

/** Messages from the host arrive as `message` events on the window. */
export function createWebviewTransport(
  vscode: Pick<VsCodeApi, 'postMessage'>,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): RpcTransport {
  return {
    post: (message) => {
      vscode.postMessage(message);
    },
    subscribe: (listener): RpcSubscription => {
      const onMessage = (event: MessageEvent<unknown>): void => {
        listener(event.data);
      };
      target.addEventListener('message', onMessage);
      return {
        dispose: () => {
          target.removeEventListener('message', onMessage);
        },
      };
    },
  };
}
