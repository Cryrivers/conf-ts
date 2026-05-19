export { Fragment } from './jsx-runtime';
export { jsx as jsxDEV } from './jsx-runtime';
export type { JsxOutputOptions } from './jsx-runtime';

export namespace JSX {
  export type Element = Record<string, any>;
  export interface IntrinsicElements {
    [elemName: string]: Record<string, any>;
  }
  export interface ElementChildrenAttribute {
    children: {};
  }
}
