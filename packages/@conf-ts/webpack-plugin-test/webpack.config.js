const path = require('path');
const {
  ConfTsWebpackPlugin,
  TypeScriptMacroTransformPlugin,
} = require('@conf-ts/webpack-plugin');

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
        test: /\.ts$/,
        use: {
          loader: 'ts-loader',
          options: { transpileOnly: true },
        },
        exclude: /node_modules/,
      },
    ],
  },
  plugins: [
    new TypeScriptMacroTransformPlugin(),
    new ConfTsWebpackPlugin({
      extensionToRemove: '.conf.ts',
    }),
  ],
};
