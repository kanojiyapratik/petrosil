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
  /**
   * A self-contained Node server, which is what the Dockerfile runs — and
   * also what `@netlify/plugin-nextjs` reads: it copies `.next/standalone`
   * into its function bundle. I briefly made this conditional on NETLIFY,
   * on the assumption the plugin did its own packaging and must not be
   * handed standalone. The failed build disproved it by reading exactly
   * that directory, so it is unconditional and both hosts want it.
   */
  output: "standalone",
  /**
   * The disk file store reads paths it builds at run time, and the tracer
   * follows them into `storage/`: the 37,770 local files' sidecars were being
   * copied into the server bundle. Uploaded files are data, not code.
   */
  outputFileTracingExcludes: { "*": ["storage/**"] },
  // The compat API answers machine callers; no image or font pipeline needed yet.
  poweredByHeader: false,
  allowedDevOrigins:
    devOrigins.length > 0
      ? devOrigins
      : ["localhost", "127.0.0.1", "192.168.*.*", "10.*.*.*", "172.16.*.*", "172.25.*.*"],
};

export default nextConfig;
