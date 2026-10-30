import { describe, expect, it } from 'vitest';
import { findAll, findFirst, parseXml } from '../../../../src/services/explain/xml-tree';

describe('parseXml', () => {
  it('reads elements, attributes and nesting', () => {
    const root = parseXml(
      '<?xml version="1.0"?><!-- plan --><a x="1" y=\'two\'><b/><c z="3"><d></d></c></a>',
    );
    expect(root.name).toBe('a');
    expect(root.attributes).toEqual({ x: '1', y: 'two' });
    expect(root.children.map((child) => child.name)).toEqual(['b', 'c']);
    expect(root.children[1]?.children[0]?.name).toBe('d');
  });

  it('decodes entities, numeric ones included', () => {
    const root = parseXml('<a t="&lt;&gt; &amp; &quot;q&quot; &apos;s&apos; &#65;&#x42;"/>');
    expect(root.attributes.t).toBe('<> & "q" \'s\' AB');
  });

  it('keeps a > inside quoted values and drops namespace prefixes', () => {
    const root = parseXml('<ns:a xmlns:ns="u" ns:t="a > b"><ns:b/></ns:a>');
    expect(root.name).toBe('a');
    expect(root.attributes).toEqual({ t: 'a > b' });
    expect(root.children[0]?.name).toBe('b');
  });

  it('skips text, CDATA and doctype', () => {
    const root = parseXml('<!DOCTYPE a><a>text<![CDATA[<b/>]]><c/></a>');
    expect(root.children.map((child) => child.name)).toEqual(['c']);
  });

  it('refuses broken documents', () => {
    expect(() => parseXml('<a><b></a>')).toThrow('closes');
    expect(() => parseXml('<a>')).toThrow('incomplete');
    expect(() => parseXml('<a x="1')).toThrow('incomplete');
    expect(() => parseXml('')).toThrow('incomplete');
  });
});

describe('findAll and findFirst', () => {
  const root = parseXml('<r><op id="1"><x><op id="2"/></x></op><op id="3"/><y><z id="9"/></y></r>');

  it('finds the nearest matches without looking inside them', () => {
    expect(findAll(root, 'op').map((one) => one.attributes.id)).toEqual(['1', '3']);
  });

  it('stops at the given element', () => {
    expect(findFirst(root, 'z')?.attributes.id).toBe('9');
    expect(findFirst(root, 'z', 'y')).toBeUndefined();
  });
});
