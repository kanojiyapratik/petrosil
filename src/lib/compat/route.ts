/**
 * The plumbing every compat endpoint shares: authenticate, run, map errors to
 * the status codes the module's SiteClient already knows how to read.
 *
 * SiteClient treats 401 and 403 as "check the token or the firewall", reads
 * `message` out of any other failure, and shows it to the editor. So every
 * error here carries a `message` that would make sense in a console toast.
 */

import { NextResponse } from "next/server";

import { AuthError, authenticate, callerIp, type Caller } from "./auth";
import { BatchError } from "@/domain/price/batches";

export type RouteContext = { params: Promise<{ site: string; id?: string }> };

export type Handler = (args: {
  request: Request;
  caller: Caller;
  params: { site: string; id?: string };
  ip: string | null;
}) => Promise<NextResponse> | NextResponse;

export function compat(handler: Handler) {
  return async function route(request: Request, context: RouteContext): Promise<NextResponse> {
    const params = await context.params;

    try {
      const caller = await authenticate(request, params.site);

      return await handler({ request, caller, params, ip: callerIp(request) });
    } catch (error) {
      if (error instanceof AuthError) {
        return NextResponse.json({ message: error.message }, { status: error.status });
      }

      if (error instanceof BatchError) {
        return NextResponse.json({ message: error.message }, { status: error.status });
      }

      // Anything unplanned is ours, not the caller's: say so plainly and let
      // the server log carry the detail.
      console.error("compat endpoint failed", { path: new URL(request.url).pathname, error });

      return NextResponse.json({ message: "The site hit an unexpected error." }, { status: 500 });
    }
  };
}

/** Laravel's 422 shape, which the module's error path already reads. */
export function unprocessable(message: string, field?: string): NextResponse {
  return NextResponse.json(
    field ? { message, errors: { [field]: [message] } } : { message },
    { status: 422 },
  );
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();

    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Numeric path segment, or null when it is not one. */
export function idFrom(params: { id?: string }): number | null {
  const id = Number(params.id);

  return Number.isInteger(id) && id > 0 ? id : null;
}
