/**
 * Who is signed in, from inside a server component.
 *
 * The API routes read the cookie off the Request; a page has no Request, so
 * it reads it through `cookies()` instead. Everything after that is the same
 * code the API uses — `identify`, `visibleSites` — because two answers to
 * "which brands may this person see" is one answer too many.
 */

import { cookies } from "next/headers";

import { COOKIE, identify, type Identity } from "./session";
import { isSuperadmin, visibleSites } from "./guard";

export type Viewer = {
  identity: Identity;
  siteIds: number[];
  isSuperadmin: boolean;
};

export async function currentIdentity(): Promise<Identity | null> {
  // Async in this version of Next: see node_modules/next/dist/docs/01-app/
  // 03-api-reference/04-functions/cookies.md.
  const jar = await cookies();

  return identify(jar.get(COOKIE)?.value ?? null);
}

/**
 * The viewer, or null when nobody signed in may use the admin. A reader with
 * a valid session is null here too: a subscriber is not staff, and the admin
 * is not theirs.
 */
export async function currentViewer(): Promise<Viewer | null> {
  const identity = await currentIdentity();

  if (!identity) {
    return null;
  }

  const superadmin = isSuperadmin(identity);
  const siteIds = visibleSites(identity);

  if (!superadmin && siteIds.length === 0) {
    return null;
  }

  return { identity, siteIds, isSuperadmin: superadmin };
}
