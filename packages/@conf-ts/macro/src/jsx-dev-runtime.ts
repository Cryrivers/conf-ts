export { Fragment } from './jsx-runtime';
export { jsx as jsxDEV } from './jsx-runtime';

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
