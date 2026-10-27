/**
 * Impex sheets on the brand sites: the list, one sheet, and its spreadsheet.
 *
 * The same paywall as reports: everyone sees the title and description; the
 * file downloads for anybody when the sheet is open to everyone, and for a
 * paying reader or the team when it is for subscribers. Anyone else is told
 * why not.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { GET as downloadRoute } from "@/app/api/public/[site]/impex/[slug]/download/route";
import { db } from "@/db";
import { impexSheets, mediaFiles } from "@/db/schema";
import { diskStore, type FileStore } from "@/lib/files/store";
import { impexDownload, publishedSheet, publishedSheets } from "@/domain/public/impex";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let root: string;
let store: FileStore;
let baseoil: Brand;
let bitumart: Brand;

const anonymous = { entitled: false, tier: "anonymous", reason: "anonymous" } as const;
const free = { entitled: false, tier: "free", reason: "free" } as const;
const paying = { entitled: true, tier: "premium", reason: "premium" } as const;

async function sheet(brand: Brand, over: Partial<typeof impexSheets.$inferInsert> = {}) {
  const [row] = await db()
    .insert(impexSheets)
    .values({
      siteId: brand.siteId,
      slug: "india-imports-sep-2026",
      title: "India base oil imports — September 2026",
      description: "By port and grade.",
      status: "premium",
      file: "india-sep.xlsx",
      authoredOn: "2026-10-15",
      ...over,
    })
    .returning();

  return row!;
}

async function stored(brand: Brand, name: string) {
  const path = `${brand.slug}/impex/files/${name}`;

  await store.put(path, new TextEncoder().encode("PK sheet"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await db().insert(mediaFiles).values({ siteId: brand.siteId, path, folder: "impex/files", name, kind: "application/vnd.ms-excel", bytes: 8 });
}

beforeEach(async () => {
  await resetDatabase();
  root = await mkdtemp(join(tmpdir(), "petrosil-impex-"));
  store = diskStore(root);
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("impex sheets for readers", () => {
  it("lists what is published or for subscribers, newest first, never a draft, a withdrawn one or another brand's", async () => {
    await sheet(baseoil, { slug: "old", authoredOn: "2026-08-01", status: "published" });
    await sheet(baseoil, { slug: "new" });
    await sheet(baseoil, { slug: "draft", status: "draft" });
    await sheet(baseoil, { slug: "gone", deletedAt: new Date() });
    await sheet(bitumart, { slug: "theirs" });

    const page = await publishedSheets(baseoil.siteId, {});

    expect(page.sheets.map((row) => [row.slug, row.premium])).toEqual([
      ["new", true],
      ["old", false],
    ]);
    expect(JSON.stringify(page)).not.toContain("india-sep.xlsx");
    expect((await publishedSheets(baseoil.siteId, { search: "OLD" })).total).toBe(0);
  });

  it("says whether this reader may download, and why not", async () => {
    await sheet(baseoil);
    await stored(baseoil, "india-sep.xlsx");

    expect((await publishedSheet(baseoil.siteId, "india-imports-sep-2026", anonymous))!.download.reason).toBe("sign_in");
    expect((await publishedSheet(baseoil.siteId, "india-imports-sep-2026", free))!.download.reason).toBe("subscribe");
    expect((await publishedSheet(baseoil.siteId, "india-imports-sep-2026", paying))!.download).toMatchObject({ allowed: true });
    expect(await publishedSheet(baseoil.siteId, "nothing", paying)).toBeNull();
  });

  it("hands the file to a paying reader, named after the sheet, and counts it", async () => {
    await sheet(baseoil);
    await stored(baseoil, "india-sep.xlsx");

    const result = await impexDownload(baseoil.siteId, "india-imports-sep-2026", paying, store);

    expect(result.ok && result.filename).toBe("india-imports-sep-2026.xlsx");

    const [row] = await db().select().from(impexSheets).where(eq(impexSheets.slug, "india-imports-sep-2026"));

    expect(row!.clicks).toBe(1);
  });

  it("refuses a subscribers-only file to a free reader, and answers 404 for a missing file", async () => {
    await sheet(baseoil);

    expect(await impexDownload(baseoil.siteId, "india-imports-sep-2026", free, store)).toMatchObject({ ok: false, status: 403 });
    expect(await impexDownload(baseoil.siteId, "india-imports-sep-2026", paying, store)).toMatchObject({ ok: false, status: 404 });
  });

  it("tells a visitor to sign in at the route", async () => {
    await sheet(baseoil);

    const response = await downloadRoute(new Request("http://platform.test/api/public/baseoil/impex/india-imports-sep-2026/download"), {
      params: Promise.resolve({ site: "baseoil", slug: "india-imports-sep-2026" }),
    });

    expect(response.status).toBe(401);
  });
});
