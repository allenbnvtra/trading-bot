import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // This machine has other, unrelated lockfiles higher up the filesystem
  // tree; pin the workspace root explicitly so Next.js doesn't guess wrong.
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
