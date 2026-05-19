/** @jsxImportSource @conf-ts/macro */

const shared = { role: 'button', dataId: 'shared' };

export default {
  basic: <button id="submit" disabled />,
  withTypeAttr: <input type="text" name="email" />,
  spreadAndKey: <div {...shared} key="root" />,
  singleChild: (
    <section>
      <span />
    </section>
  ),
  multiChild: (
    <ul>
      <li>a</li>
      <li>b</li>
    </ul>
  ),
  fragment: (
    <>
      <span />
      <span label="x" />
    </>
  ),
};
