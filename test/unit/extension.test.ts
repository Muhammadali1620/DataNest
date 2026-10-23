import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { activate, deactivate } from '../../src/extension';

describe('extension entry point', () => {
  it('activates and deactivates without touching the context', () => {
    const context = {} as vscode.ExtensionContext;
    expect(() => {
      activate(context);
    }).not.toThrow();
    expect(() => {
      deactivate();
    }).not.toThrow();
  });
});
