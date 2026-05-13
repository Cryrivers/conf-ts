/** @jsxImportSource @conf-ts/macro */

export default {
  intrinsic: <page />,
  withStringAttr: <button id="submit" />,
  withBoolAttr: <input disabled />,
  withExprAttr: <div count={42} />,
  withTextChild: <p>hello</p>,
  singleChild: <div><span /></div>,
  multiChild: <ul><li>a</li><li>b</li></ul>,
  fragment: <><span /><span /></>,
  emptyFragment: <></>,
  singleFragment: <><p /></>,
  customTag: <Button variant="primary" />,
  nested: <div><section><p>deep</p></section></div>,
  mixed: <div id="root"><h1>title</h1>{42}</div>,
};
