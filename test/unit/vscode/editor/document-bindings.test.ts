import { describe, expect, it, vi } from 'vitest';
import { DocumentBindings } from '../../../../src/vscode/editor/document-bindings';

const A = 'untitled:Query-1.sql';
const B = 'file:///tmp/report.sql';

describe('DocumentBindings', () => {
  it('starts empty', () => {
    const bindings = new DocumentBindings();
    expect(bindings.size).toBe(0);
    expect(bindings.get(A)).toBeUndefined();
    expect(bindings.documents()).toEqual([]);
  });

  it('binds a document to a connection', () => {
    const bindings = new DocumentBindings();
    bindings.bind(A, { connectionId: 'c1' });
    expect(bindings.get(A)).toEqual({ connectionId: 'c1' });
    expect(bindings.documents()).toEqual([A]);
  });

  it('keeps the database when one is given and drops it when not', () => {
    const bindings = new DocumentBindings();
    bindings.bind(A, { connectionId: 'c1', database: 'app' });
    expect(bindings.get(A)).toEqual({ connectionId: 'c1', database: 'app' });
    bindings.bind(A, { connectionId: 'c1' });
    expect(bindings.get(A)).toEqual({ connectionId: 'c1' });
  });

  it('keeps documents apart', () => {
    const bindings = new DocumentBindings();
    bindings.bind(A, { connectionId: 'c1' });
    bindings.bind(B, { connectionId: 'c2', database: 'shop' });
    expect(bindings.get(A)).toEqual({ connectionId: 'c1' });
    expect(bindings.get(B)).toEqual({ connectionId: 'c2', database: 'shop' });
    expect(bindings.size).toBe(2);
  });

  describe('events', () => {
    it('fires on bind, rebind and unbind', () => {
      const bindings = new DocumentBindings();
      const changed = vi.fn();
      bindings.onDidChange(changed);
      bindings.bind(A, { connectionId: 'c1' });
      bindings.bind(A, { connectionId: 'c2' });
      bindings.unbind(A);
      expect(changed.mock.calls).toEqual([[A], [A], [A]]);
    });

    it('stays quiet when the binding does not actually change', () => {
      const bindings = new DocumentBindings();
      const changed = vi.fn();
      bindings.bind(A, { connectionId: 'c1', database: 'app' });
      bindings.onDidChange(changed);
      bindings.bind(A, { connectionId: 'c1', database: 'app' });
      expect(changed).not.toHaveBeenCalled();
    });

    it('fires when only the database changes', () => {
      const bindings = new DocumentBindings();
      bindings.bind(A, { connectionId: 'c1', database: 'app' });
      const changed = vi.fn();
      bindings.onDidChange(changed);
      bindings.bind(A, { connectionId: 'c1', database: 'shop' });
      expect(changed).toHaveBeenCalledWith(A);
    });

    it('stays quiet when unbinding something that was never bound', () => {
      const bindings = new DocumentBindings();
      const changed = vi.fn();
      bindings.onDidChange(changed);
      bindings.unbind('untitled:never.sql');
      expect(changed).not.toHaveBeenCalled();
    });

    it('stops notifying a disposed listener', () => {
      const bindings = new DocumentBindings();
      const changed = vi.fn();
      bindings.onDidChange(changed).dispose();
      bindings.bind(A, { connectionId: 'c1' });
      expect(changed).not.toHaveBeenCalled();
    });
  });

  describe('unbind', () => {
    it('forgets one document and leaves the others', () => {
      const bindings = new DocumentBindings();
      bindings.bind(A, { connectionId: 'c1' });
      bindings.bind(B, { connectionId: 'c1' });
      bindings.unbind(A);
      expect(bindings.get(A)).toBeUndefined();
      expect(bindings.get(B)).toEqual({ connectionId: 'c1' });
    });
  });

  describe('unbindConnection', () => {
    it('drops every document of a connection and reports them', () => {
      const bindings = new DocumentBindings();
      bindings.bind(A, { connectionId: 'c1' });
      bindings.bind(B, { connectionId: 'c1', database: 'app' });
      bindings.bind('untitled:other.sql', { connectionId: 'c2' });
      expect(bindings.unbindConnection('c1').sort()).toEqual([B, A].sort());
      expect(bindings.size).toBe(1);
      expect(bindings.get('untitled:other.sql')).toEqual({ connectionId: 'c2' });
    });

    it('reports nothing for a connection without documents', () => {
      const bindings = new DocumentBindings();
      bindings.bind(A, { connectionId: 'c1' });
      expect(bindings.unbindConnection('c2')).toEqual([]);
      expect(bindings.size).toBe(1);
    });
  });
});
