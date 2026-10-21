import type { NextConfig } from "next";

/**
 * Origins the dev server will accept cross-origin requests from.
 *
 * Next refuses them by default, which is right: without it any page you
 * happened to have open could poke a dev server on your own machine. The
 * admin is served on the LAN so colleagues can open it, so the private
 * ranges are allowed and nothing else. Set `DEV_ORIGINS` to a comma-separated
 * list to narrow it to one machine.
 *
 * This affects `next dev` only. A production server does not read it.
 */
const devOrigins = (process.env.DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  output: "standalone",
  // The compat API answers machine callers; no image or font pipeline needed yet.
  poweredByHeader: false,
  allowedDevOrigins:
    devOrigins.length > 0
      ? devOrigins
      : ["localhost", "127.0.0.1", "192.168.*.*", "10.*.*.*", "172.16.*.*", "172.25.*.*"],
};

export default nextConfig;
