import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  reactCompiler: true,
  serverExternalPackages: [
    '@conf-ts/compiler-native',
    '@conf-ts/diff',
    '@conf-ts/diff-native',
    '@conf-ts/macro-transformer-native',
  ],
  outputFileTracingIncludes: {
    '/api/diff': ['./server/diff-worker.mjs'],
  },
};

export default nextConfig;
