/**
 * Browsers ask for /favicon.ico before (or without) reading the <link rel="icon">
 * that points at app/icon.svg; without this they get a 404 and log a console error.
 */
export function GET() {
  return new Response(null, {
    status: 308,
    headers: { location: "/icon.svg", "cache-control": "public, max-age=86400" },
  });
}
