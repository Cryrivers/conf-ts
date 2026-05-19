const path = require('path');
const { ConfTsWebpackPlugin } = require('@conf-ts/webpack-plugin');

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
  plugins: [
    new ConfTsWebpackPlugin({
      extensionToRemove: '.conf.ts',
      jsxOutput: { type: '$type', props: false },
    }),
  ],
};
