const path = require('path');

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
              extensionToRemove: '.conf.ts'
            },
          },
        ],
      },
    ],
  },
};