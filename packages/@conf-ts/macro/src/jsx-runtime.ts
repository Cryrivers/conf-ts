export const Fragment = 'Fragment';

export function jsx(
  type: string,
  props: Record<string, any>,
  key?: string,
): Record<string, any> {
  if (key !== undefined) {
    props = { ...props, key };
  }
  return { type, props };
}

export const jsxs = jsx;

export namespace JSX {
  export type Element = Record<string, any>;
  export interface IntrinsicElements {
    [elemName: string]: Record<string, any>;
  }
  export interface ElementChildrenAttribute {
    children: {};
  }
}
