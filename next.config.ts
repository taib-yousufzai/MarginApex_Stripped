import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
});

const nextConfig: NextConfig = {
  output: 'standalone', // enables minimal Docker image via Dockerfile.nextjs
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    scrollRestoration: false,
  },
  turbopack: {},
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      {
        source: '/charting_library/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
    ];
  },
};

export default withSerwist(nextConfig);
