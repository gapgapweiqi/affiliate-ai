/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Pages read live data from Postgres on every request.
  experimental: {},
};
export default nextConfig;
