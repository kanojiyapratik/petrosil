import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The compat API answers machine callers; no image or font pipeline needed yet.
  poweredByHeader: false,
};

export default nextConfig;
