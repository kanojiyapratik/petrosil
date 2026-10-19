/**
 * The wrapper for endpoints any signed-in person may use.
 *
 * `dashboard()` next door refuses a reader, because that area is staff-only.
 * This one refuses nobody who is signed in: a subscriber managing their own
 * account is the whole point of it.
 */

import { NextResponse } from "next/server";

import { identify, type Identity } from "./session";
import { tokenFrom } from "./guard";
import { AccountError } from "@/domain/accounts/register";

export type AccountArgs = {
  request: Request;
  identity: Identity;
  params: Record<string, string>;
};

export function account(
  handler: (args: AccountArgs) => Promise<NextResponse> | NextResponse,
) {
  return async function route(
    request: Request,
    context?: { params?: Promise<Record<string, string>> },
  ): Promise<NextResponse> {
    const params = (await context?.params) ?? {};

    try {
      const identity = await identify(tokenFrom(request));

      if (!identity) {
        return NextResponse.json({ message: "Sign in to continue." }, { status: 401 });
      }

      return await handler({ request, identity, params });
    } catch (error) {
      if (error instanceof AccountError) {
        return NextResponse.json(
          error.field ? { message: error.message, errors: { [error.field]: [error.message] } } : { message: error.message },
          { status: error.status },
        );
      }

      console.error("account endpoint failed", { path: new URL(request.url).pathname, error });

      return NextResponse.json({ message: "Something went wrong." }, { status: 500 });
    }
  };
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();

    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
