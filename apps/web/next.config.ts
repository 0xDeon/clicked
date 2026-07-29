import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '',
  },
  async redirects() {
    return [
      {
        source: '/conversations/:id',
        destination: '/app/conversations/:id',
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
