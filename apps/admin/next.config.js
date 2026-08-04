/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@cts/shared', '@cts/ui'],
};
module.exports = nextConfig;
