# @conf-ts/swc-plugin

Standard SWC WASM plugin for the `@conf-ts/macro` source transform. Configure
it with the same `filename`, `project`, and transform option snapshot accepted
by `@conf-ts/macro-transformer-native`. The plugin performs no filesystem
reads; cross-file evaluation requires `project.files` and `project.resolutions`.

```js
const { transformSync } = require('@swc/core');

const result = transformSync(source, {
  filename: '/virtual/config.ts',
  jsc: {
    parser: { syntax: 'typescript' },
    experimental: {
      plugins: [
        [
          require.resolve('@conf-ts/swc-plugin'),
          {
            project: {
              files: { '/virtual/config.ts': source },
              resolutions: {},
            },
          },
        ],
      ],
    },
  },
});
```

Pass environment values explicitly through `env`; the WASM plugin never reads
the host process environment.
