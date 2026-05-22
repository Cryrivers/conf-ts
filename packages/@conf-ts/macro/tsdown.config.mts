import { defineConfig } from 'tsdown/config';

export default defineConfig({
  entry: {
    index: './src/index.ts',
    'jsx-runtime': './src/jsx-runtime.ts',
    'jsx-dev-runtime': './src/jsx-dev-runtime.ts',
  },
  format: {
    esm: {
      target: ['es2015'],
    },
    cjs: {
      target: ['node20'],
    },
  },
  dts: true,
  sourcemap: true,
  clean: true,
});
