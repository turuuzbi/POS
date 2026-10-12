import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * Baseline security headers. A strict Content-Security-Policy (with nonces)
 * lands in Phase 6 together with the service worker, since both constrain
 * script loading.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // Camera is needed for the barcode-scanner fallback on the register.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // Cache Components is deliberately off: every POS screen is per-user and
  // dynamic, and the checkout itself runs client-side (IndexedDB, offline).
  cacheComponents: false,
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default withNextIntl(nextConfig);
