/**
 * Reports on the brand sites: the list, one report, and its PDF.
 *
 * Everyone sees a report's title, description and cover. The PDF is the paid
 * part: a report open to everyone (a sample, say) downloads for anybody, one
 * for subscribers only downloads for a paying reader or the team, and anyone
 * else is told why not — sign in, subscribe, or renew — rather than handed a
 * broken link. The old sites served the PDF from a public folder, so its
 * address was the whole paywall.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { GET as listRoute } from "@/app/api/public/[site]/reports/route";
import { GET as detailRoute } from "@/app/api/public/[site]/reports/[slug]/route";
import { GET as downloadRoute } from "@/app/api/public/[site]/reports/[slug]/download/route";
import { db } from "@/db";
import { mediaFiles, reports } from "@/db/schema";
import { diskStore, type FileStore } from "@/lib/files/store";
import { entitlementFor } from "@/domain/public/paywall";
import { publishedReport, publishedReports, reportDownload } from "@/domain/public/reports";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let root: string;
let store: FileStore;
let baseoil: Brand;
let bitumart: Brand;

const anonymous = entitlementFor({ userId: null, memberships: [] }, 0, "2026-10-27");
const free = { entitled: false, tier: "free", reason: "free" } as const;
const lapsed = { entitled: false, tier: "premium", reason: "expired" } as const;
const paying = { entitled: true, tier: "premium", reason: "premium" } as const;

async function report(brand: Brand, over: Partial<typeof reports.$inferInsert> = {}) {
  const [row] = await db()
    .insert(reports)
    .values({
      siteId: brand.siteId,
      slug: "october-2026",
      title: "Base Oil Monthly — October 2026",
      description: "Asia and the Middle East.",
      reportType: "report",
      status: "premium",
      file: "october-2026.pdf",
      thumbnail: "october-cover.png",
      authoredOn: "2026-10-20",
      ...over,
    })
    .returning();

  return row!;
}

async function stored(brand: Brand, name: string, body = "%PDF-1.4 the report") {
  const path = `${brand.slug}/reports/files/${name}`;

  await store.put(path, new TextEncoder().encode(body), "application/pdf");
  await db().insert(mediaFiles).values({ siteId: brand.siteId, path, folder: "reports/files", name, kind: "application/pdf", bytes: body.length });
}

beforeEach(async () => {
  await resetDatabase();
  root = await mkdtemp(join(tmpdir(), "petrosil-reports-"));
  store = diskStore(root);
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the report list", () => {
  it("shows what is published or for subscribers, newest first, never a draft or a withdrawn one", async () => {
    await report(baseoil, { slug: "old", authoredOn: "2026-09-01", status: "published" });
    await report(baseoil, { slug: "new", authoredOn: "2026-10-20" });
    await report(baseoil, { slug: "draft", status: "draft" });
    await report(baseoil, { slug: "gone", deletedAt: new Date() });
    await report(bitumart, { slug: "theirs" });

    const page = await publishedReports(baseoil.siteId);

    expect(page.total).toBe(2);
    expect(page.reports.map((row) => [row.slug, row.premium])).toEqual([
      ["new", true],
      ["old", false],
    ]);
    // The cover is a public picture; the PDF's address is never in a list.
    expect(page.reports[0]).toMatchObject({ thumbnail_url: "/api/public/baseoil/files/reports/thumbnail/october-cover.png" });
    expect(JSON.stringify(page)).not.toContain("october-2026.pdf");
  });

  it("filters by kind and by words in the title", async () => {
    await report(baseoil, { slug: "a", title: "Singapore weekly" });
    await report(baseoil, { slug: "b", title: "Free sample", reportType: "sample", status: "published" });

    expect((await publishedReports(baseoil.siteId, { type: "sample" })).reports.map((row) => row.slug)).toEqual(["b"]);
    expect((await publishedReports(baseoil.siteId, { search: "singapore" })).reports.map((row) => row.slug)).toEqual(["a"]);
  });
});

describe("one report", () => {
  it("says whether this reader may download it, and if not why", async () => {
    await report(baseoil);
    await stored(baseoil, "october-2026.pdf");

    expect((await publishedReport(baseoil.siteId, "october-2026", anonymous))!.download).toEqual({
      allowed: false,
      reason: "sign_in",
      url: "/api/public/baseoil/reports/october-2026/download",
    });
    expect((await publishedReport(baseoil.siteId, "october-2026", free))!.download.reason).toBe("subscribe");
    expect((await publishedReport(baseoil.siteId, "october-2026", lapsed))!.download.reason).toBe("renew");
    expect((await publishedReport(baseoil.siteId, "october-2026", paying))!.download).toMatchObject({ allowed: true, reason: null });
  });

  it("says there is nothing to download when the PDF is not in the store", async () => {
    await report(baseoil, { status: "published" });

    expect((await publishedReport(baseoil.siteId, "october-2026", paying))!.download).toEqual({
      allowed: false,
      reason: "no_file",
      url: null,
    });
  });

  it("answers a draft, a withdrawn report and another brand's the same as none", async () => {
    await report(baseoil, { slug: "draft", status: "draft" });
    await report(bitumart, { slug: "theirs" });

    expect(await publishedReport(baseoil.siteId, "draft", paying)).toBeNull();
    expect(await publishedReport(baseoil.siteId, "theirs", paying)).toBeNull();
  });
});

describe("the download", () => {
  it("hands a paying reader the PDF and counts it", async () => {
    await report(baseoil);
    await stored(baseoil, "october-2026.pdf", "%PDF-1.4 paid");

    const result = await reportDownload(baseoil.siteId, "october-2026", paying, store);

    expect(result.ok).toBe(true);
    expect(result.ok && new TextDecoder().decode(result.file.body)).toBe("%PDF-1.4 paid");
    expect(result.ok && result.filename).toBe("october-2026.pdf");

    const [row] = await db().select().from(reports).where(eq(reports.slug, "october-2026"));

    expect(row!.clicks).toBe(1);
  });

  it("hands anybody a report open to everyone", async () => {
    await report(baseoil, { status: "published", reportType: "sample" });
    await stored(baseoil, "october-2026.pdf");

    expect((await reportDownload(baseoil.siteId, "october-2026", anonymous, store)).ok).toBe(true);
  });

  it("refuses a subscribers-only PDF to everyone else, saying why, and counts nothing", async () => {
    await report(baseoil);
    await stored(baseoil, "october-2026.pdf");

    expect(await reportDownload(baseoil.siteId, "october-2026", anonymous, store)).toMatchObject({ ok: false, status: 401, reason: "sign_in" });
    expect(await reportDownload(baseoil.siteId, "october-2026", free, store)).toMatchObject({ ok: false, status: 403, reason: "subscribe" });
    expect(await reportDownload(baseoil.siteId, "october-2026", lapsed, store)).toMatchObject({ ok: false, status: 403, reason: "renew" });

    const [row] = await db().select().from(reports).where(eq(reports.slug, "october-2026"));

    expect(row!.clicks).toBe(0);
  });

  it("answers 404 for a report or a file that is not there", async () => {
    await report(baseoil, { status: "published" });

    expect(await reportDownload(baseoil.siteId, "october-2026", paying, store)).toMatchObject({ ok: false, status: 404 });
    expect(await reportDownload(baseoil.siteId, "nothing", paying, store)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("the routes", () => {
  const get = (url: string) => new Request(`http://platform.test${url}`);

  it("list and show reports to a visitor", async () => {
    await report(baseoil);

    const list = await (await listRoute(get("/api/public/baseoil/reports"), { params: Promise.resolve({ site: "baseoil" }) })).json();
    const one = await (
      await detailRoute(get("/api/public/baseoil/reports/october-2026"), { params: Promise.resolve({ site: "baseoil", slug: "october-2026" }) })
    ).json();

    expect(list.reports).toHaveLength(1);
    expect(one.report).toMatchObject({ slug: "october-2026", title: "Base Oil Monthly — October 2026" });
  });

  it("tell a visitor to sign in before a paid download", async () => {
    await report(baseoil);

    const response = await downloadRoute(get("/api/public/baseoil/reports/october-2026/download"), {
      params: Promise.resolve({ site: "baseoil", slug: "october-2026" }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: "sign_in" });
  });
});
