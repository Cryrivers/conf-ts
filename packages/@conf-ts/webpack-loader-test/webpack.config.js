const path = require('path');
const { ConfTsJsxOutputPlugin } = require('@conf-ts/webpack-loader');

const jsxOutput = { type: '$type', props: false };

module.exports = {
  mode: 'development',
  entry: './src/index.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.js',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.conf\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: '@conf-ts/webpack-loader',
            options: {
              extensionToRemove: '.conf.ts',
              jsxOutput,
            },
          },
        ],
      },
    ],
  },
  plugins: [new ConfTsJsxOutputPlugin({ jsxOutput })],
};
