import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // DO App Platform strips the route prefix (/dashboard) before forwarding
  // to the service, so basePath is not needed. But assets still need the
  // prefix so they route to the dashboard service, not the API.
  assetPrefix: process.env.NEXT_PUBLIC_ASSET_PREFIX || '',
};

export default nextConfig;
