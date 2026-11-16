/**
 * /api/public/unsubscribe/{token} — the newsletter's unsubscribe endpoint.
 *
 * POST takes two callers:
 * - a mail client's one-click button (RFC 8058: body `List-Unsubscribe=One-Click`),
 *   answered with a plain 200 and nothing to render;
 * - the form on the /unsubscribe page, which can also say `again=1` to come
 *   back, answered by sending the reader back to that page.
 *
 * GET only forwards to the page: link scanners in mail systems open every link,
 * and a GET that unsubscribed would take readers off without their asking.
 *
 * Redirects carry a bare path: behind Railway `request.url` is 0.0.0.0:8080.
 */
import { setUnsubscribed } from "@/domain/content/newsletter-send";

export const dynamic = "force-dynamic";

function back(token: string, query = ""): Response {
  return new Response(null, { status: 303, headers: { location: `/unsubscribe/${encodeURIComponent(token)}${query}` } });
}

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;

  return back(token);
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const form = await request.formData().catch(() => null);
  const oneClick = form?.get("List-Unsubscribe") === "One-Click";
  const again = form?.get("again") === "1";

  const done = await setUnsubscribed(token, !again);

  if (oneClick) {
    // Known token or not, the same answer: it reveals nothing.
    return new Response(null, { status: 200 });
  }

  return back(token, done ? (again ? "?back=1" : "?done=1") : "");
}
