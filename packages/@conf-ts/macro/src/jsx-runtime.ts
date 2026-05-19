export interface JsxOutputOptions {
  type?: string;
  props?: string | false;
  children?: string | false;
  key?: string;
  fragment?: string;
}

declare global {
  var __CONF_TS_JSX_OUTPUT__: JsxOutputOptions | undefined;
}

type NormalizedJsxOutputOptions = {
  type: string;
  props: string | false;
  children: string | false;
  key: string;
  fragment: string;
};

type JsxProps = Record<string, any> | null | undefined;

export const Fragment = 'Fragment';

function validateJsxName(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Invalid option: jsxOutput.${field} must be a non-empty string`,
    );
  }
  return value;
}

function validateJsxField(
  value: unknown,
  field: string,
  defaultValue: string,
): string | false {
  if (value === undefined) {
    return defaultValue;
  }
  if (value === false) {
    return false;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Invalid option: jsxOutput.${field} must be a non-empty string or false`,
    );
  }
  return value;
}

function normalizeJsxOutputOptions(): NormalizedJsxOutputOptions {
  const raw = globalThis.__CONF_TS_JSX_OUTPUT__ ?? {};
  const normalized: NormalizedJsxOutputOptions = {
    type: raw.type === undefined ? 'type' : validateJsxName(raw.type, 'type'),
    props: validateJsxField(raw.props, 'props', 'props'),
    children: validateJsxField(raw.children, 'children', 'children'),
    key: raw.key === undefined ? 'key' : validateJsxName(raw.key, 'key'),
    fragment:
      raw.fragment === undefined
        ? 'Fragment'
        : validateJsxName(raw.fragment, 'fragment'),
  };

  const enabledFields = [
    ['type', normalized.type],
    ['key', normalized.key],
    ...(normalized.props === false ? [] : [['props', normalized.props]]),
    ...(normalized.children === false
      ? []
      : [['children', normalized.children]]),
  ] as [string, string][];
  const seen = new Map<string, string>();
  for (const [field, value] of enabledFields) {
    const existing = seen.get(value);
    if (existing) {
      throw new Error(
        `Invalid option: jsxOutput.${field} conflicts with jsxOutput.${existing} field "${value}"`,
      );
    }
    seen.set(value, field);
  }

  return normalized;
}

function isWhitespaceOnlyChild(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.every(isWhitespaceOnlyChild);
  }
  return false;
}

function assertChildrenAllowed(value: unknown) {
  if (!isWhitespaceOnlyChild(value)) {
    throw new Error('JSX children are disabled by jsxOutput.children: false');
  }
}

function assertNoFlatJsxPropCollision(
  props: Record<string, any>,
  jsxOutput: NormalizedJsxOutputOptions,
) {
  const protectedFields = new Set([jsxOutput.type, jsxOutput.key]);
  if (jsxOutput.children !== false) {
    protectedFields.add(jsxOutput.children);
  }

  for (const key of Object.keys(props)) {
    if (protectedFields.has(key)) {
      throw new Error(
        `JSX prop "${key}" conflicts with JSX output field "${key}"`,
      );
    }
  }
}

function createJsxNode(
  type: string,
  inputProps: JsxProps,
  key?: string,
): Record<string, any> {
  const jsxOutput = normalizeJsxOutputOptions();
  const props = inputProps ? { ...inputProps } : {};
  const hasChildren = Object.prototype.hasOwnProperty.call(props, 'children');
  const children = props.children;
  delete props.children;
  const outputType = type === Fragment ? jsxOutput.fragment : type;

  if (jsxOutput.children === false && hasChildren) {
    assertChildrenAllowed(children);
  }

  if (jsxOutput.props === false) {
    assertNoFlatJsxPropCollision(props, jsxOutput);
    const output: Record<string, any> = { [jsxOutput.type]: outputType };
    Object.assign(output, props);
    if (key !== undefined) {
      output[jsxOutput.key] = key;
    }
    if (hasChildren && jsxOutput.children !== false) {
      output[jsxOutput.children] = children;
    }
    return output;
  }

  if (key !== undefined) {
    props[jsxOutput.key] = key;
  }
  if (hasChildren && jsxOutput.children !== false) {
    props[jsxOutput.children] = children;
  }

  return {
    [jsxOutput.type]: outputType,
    [jsxOutput.props]: props,
  };
}

export function jsx(
  type: string,
  props: JsxProps,
  key?: string,
): Record<string, any> {
  return createJsxNode(type, props, key);
}

export const jsxs = jsx;

export function createElement(
  type: string,
  props: JsxProps,
  ...children: any[]
): Record<string, any> {
  const p = props ? { ...props } : {};
  const key = p.key;
  delete p.key;
  if (children.length === 1) {
    p.children = children[0];
  } else if (children.length > 1) {
    p.children = children;
  }
  return createJsxNode(type, p, key);
}

export namespace JSX {
  export type Element = Record<string, any>;
  export interface IntrinsicElements {
    [elemName: string]: Record<string, any>;
  }
  export interface ElementChildrenAttribute {
    children: {};
  }
}
