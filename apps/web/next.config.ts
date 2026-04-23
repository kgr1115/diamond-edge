import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    // Enable server actions (needed for auth flows)
    serverActions: {
      allowedOrigins: ['localhost:3000'],
    },
  },
};

export default nextConfig;
