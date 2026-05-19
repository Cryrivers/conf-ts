import { createRequire } from 'module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { Fragment, jsx, jsxs } = require('@conf-ts/macro/jsx-runtime') as {
  Fragment: string;
  jsx: (type: string, props: Record<string, any> | null, key?: string) => any;
  jsxs: (type: string, props: Record<string, any> | null, key?: string) => any;
};
const { jsxDEV } = require('@conf-ts/macro/jsx-dev-runtime') as {
  jsxDEV: (
    type: string,
    props: Record<string, any> | null,
    key?: string,
  ) => any;
};

function setJsxOutput(value: unknown) {
  (globalThis as any).__CONF_TS_JSX_OUTPUT__ = value;
}

describe('@conf-ts/macro JSX runtime', () => {
  afterEach(() => {
    delete (globalThis as any).__CONF_TS_JSX_OUTPUT__;
    vi.restoreAllMocks();
  });

  it('keeps the default runtime output shape', () => {
    expect(jsx('button', { id: 'submit', disabled: true })).toEqual({
      type: 'button',
      props: { id: 'submit', disabled: true },
    });
    expect(jsx('button', { id: 'submit' }, 'k1')).toEqual({
      type: 'button',
      props: { id: 'submit', key: 'k1' },
    });
  });

  it('supports flat props output at runtime', () => {
    setJsxOutput({ type: '$type', props: false });

    expect(jsx('input', { type: 'text', name: 'email' })).toEqual({
      $type: 'input',
      type: 'text',
      name: 'email',
    });
  });

  it('supports custom type, props, children, key, and fragment fields', () => {
    setJsxOutput({
      type: 'tag',
      props: 'attrs',
      children: 'items',
      key: 'id',
      fragment: 'Group',
    });

    const first = jsx('li', { children: 'a' });
    const second = jsx('li', { children: 'b' }, 'b-key');

    expect(
      jsxs('ul', { className: 'list', children: [first, second] }),
    ).toEqual({
      tag: 'ul',
      attrs: {
        className: 'list',
        items: [
          { tag: 'li', attrs: { items: 'a' } },
          { tag: 'li', attrs: { id: 'b-key', items: 'b' } },
        ],
      },
    });
    expect(jsx(Fragment, { children: first })).toEqual({
      tag: 'Group',
      attrs: { items: first },
    });
    expect(jsxDEV('section', { children: 'dev' })).toEqual({
      tag: 'section',
      attrs: { items: 'dev' },
    });
  });

  it('supports key, children, and fragments in flat mode', () => {
    setJsxOutput({
      type: '$type',
      props: false,
      children: 'items',
      key: 'id',
      fragment: 'Group',
    });

    const child = jsx('span', { title: 'child' });

    expect(
      jsxs('div', { className: 'root', children: [child] }, 'root-key'),
    ).toEqual({
      $type: 'div',
      className: 'root',
      id: 'root-key',
      items: [child],
    });
    expect(jsx(Fragment, { children: child })).toEqual({
      $type: 'Group',
      items: child,
    });
  });

  it('rejects flat props that collide with output fields', () => {
    setJsxOutput({ props: false });

    expect(() => jsx('input', { type: 'text' })).toThrow(
      'conflicts with JSX output field',
    );
  });

  it('rejects invalid runtime JSX output options', () => {
    setJsxOutput({ type: '' });
    expect(() => jsx('div', {})).toThrow(
      'jsxOutput.type must be a non-empty string',
    );

    setJsxOutput({ props: true });
    expect(() => jsx('div', {})).toThrow(
      'jsxOutput.props must be a non-empty string or false',
    );

    setJsxOutput({ children: true });
    expect(() => jsx('div', {})).toThrow(
      'jsxOutput.children must be a non-empty string or false',
    );

    setJsxOutput({ type: 'node', key: 'node' });
    expect(() => jsx('div', {})).toThrow(
      'jsxOutput.key conflicts with jsxOutput.type field "node"',
    );
  });

  it('rejects meaningful children when runtime children output is disabled', () => {
    setJsxOutput({ children: false });

    expect(jsx('div', { id: 'empty', children: ' \n\t ' })).toEqual({
      type: 'div',
      props: { id: 'empty' },
    });
    expect(() => jsx('div', { children: 'text' })).toThrow(
      'JSX children are disabled',
    );
    expect(() => jsx('div', { children: 0 })).toThrow(
      'JSX children are disabled',
    );
    expect(() => jsx('div', { children: [jsx('span', {})] })).toThrow(
      'JSX children are disabled',
    );
  });

  it('uses the same output helper for classic createElement', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { createElement } = require('@conf-ts/macro') as {
      createElement: (
        type: string,
        props: Record<string, any> | null,
        ...children: any[]
      ) => any;
    };

    setJsxOutput({
      type: '$type',
      props: false,
      children: 'items',
      key: 'id',
    });

    expect(
      createElement(
        'ul',
        { className: 'list', key: 'root' },
        createElement('li', null, 'a'),
        createElement('li', null, 'b'),
      ),
    ).toEqual({
      $type: 'ul',
      className: 'list',
      id: 'root',
      items: [
        { $type: 'li', items: 'a' },
        { $type: 'li', items: 'b' },
      ],
    });
  });
});
