import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: './src/index.ts',
    react: './src/react.tsx',
    cli: './src/cli.ts',
  },
  format: {
    esm: {
      target: ['node20'],
    },
    cjs: {
      target: ['node20'],
    },
  },
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: ['@monaco-editor/react', 'react', 'react-dom'],
  },
});
