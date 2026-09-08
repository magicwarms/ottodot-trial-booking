import type { NextConfig } from 'next';

const config: NextConfig = {
  // better-sqlite3 is a native module; it must stay outside the bundler.
  serverExternalPackages: ['better-sqlite3'],
};

export default config;
