export const Fragment = 'Fragment';

export function jsx(
  type: string,
  props: Record<string, any>,
  key?: string,
): { type: string; props: Record<string, any> } {
  if (key !== undefined) {
    props = { ...props, key };
  }
  return { type, props };
}

export const jsxs = jsx;

export namespace JSX {
  export interface Element {
    type: string;
    props: Record<string, any>;
  }
  export interface IntrinsicElements {
    [elemName: string]: Record<string, any>;
  }
  export interface ElementChildrenAttribute {
    children: {};
  }
}
