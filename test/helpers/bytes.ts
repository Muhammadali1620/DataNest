// Byte helpers for tests that run in the webview (jsdom) environment, where Node's
// Buffer is not part of the types.

export function hexOf(bytes: readonly number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function base64Of(bytes: readonly number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

export function bytesOfText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
