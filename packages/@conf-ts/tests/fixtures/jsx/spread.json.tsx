/** @jsxImportSource @conf-ts/macro */

const shared = { type: "text", name: "field" };

export default {
  spreadOnly: <input {...shared} />,
  spreadWithOverride: <input {...shared} name="override" />,
  spreadWithKey: <div {...shared} key="k1" />,
};
