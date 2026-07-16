const path = require('path');
const {
  ConfTsWebpackPlugin,
  NativeMacroTransformPlugin,
} = require('@conf-ts/webpack-plugin');

module.exports = {
  mode: 'development',
  entry: './src/index.ts',
  output: {
    path: path.resolve(__dirname, 'dist/native'),
    filename: 'bundle.js',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'swc-loader',
          options: {
            jsc: {
              parser: { syntax: 'typescript' },
              target: 'es2022',
            },
          },
        },
        exclude: /node_modules/,
      },
    ],
  },
  plugins: [
    new NativeMacroTransformPlugin(),
    new ConfTsWebpackPlugin({
      compiler: 'native',
      extensionToRemove: '.conf.ts',
      name: 'dist/native/[name].generated.json',
    }),
  ],
};
