/**
 * GET /api/public/open/{token} — the 1x1 image in a sent report or sample.
 * Loading it records the first open for that recipient. Always answers the
 * image, known token or not, so it reveals nothing.
 */
import { recordOpen } from "@/domain/reports/sending";

export const dynamic = "force-dynamic";

// The smallest transparent GIF.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;

  await recordOpen(token).catch(() => false);

  return new Response(PIXEL, {
    headers: {
      "content-type": "image/gif",
      "content-length": String(PIXEL.byteLength),
      "cache-control": "no-store, max-age=0",
    },
  });
}
