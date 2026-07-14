import { defineConfig } from 'tsdown/config';

export default defineConfig({
  entry: {
    index: './src/index.ts',
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
