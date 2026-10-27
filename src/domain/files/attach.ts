/**
 * Naming a stored file from a content row: a report's PDF, an offer's image.
 *
 * The old forms saved whatever file name they were handed, so a row could
 * point at a file that was never uploaded and readers got a dead link. A
 * name is accepted here only when that brand's folder holds it. Names stay
 * bare, as the carried rows have them, so old and new rows read the same.
 */

import { and, eq } from "drizzle-orm";

import type { Database } from "@/db";
import { mediaFiles } from "@/db/schema";
import { AccountError } from "@/domain/accounts/register";

/** The id of a brand's file in one folder, by bare name, or null. */
export async function storedFileId(siteId: number, folder: string, name: string, database: Database): Promise<number | null> {
  const [found] = await database
    .select({ id: mediaFiles.id })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.siteId, siteId), eq(mediaFiles.folder, folder), eq(mediaFiles.name, name)))
    .limit(1);

  return found?.id ?? null;
}

/**
 * A file name a row may carry. Undefined: not being changed. Null or blank:
 * detach. Anything else must be in the brand's folder, or the field is refused.
 */
export async function attachable(
  siteId: number,
  folder: string,
  field: string,
  value: unknown,
  what: string,
  database: Database,
): Promise<string | null | undefined> {
  if (value === undefined) {
    return undefined;
  }

  const name = typeof value === "string" ? value.trim().slice(0, 512) : "";

  if (name === "") {
    return null;
  }

  if ((await storedFileId(siteId, folder, name, database)) === null) {
    throw new AccountError(`That ${what} is not in this brand's ${folder}. Upload it here first.`, 422, field);
  }

  return name;
}
