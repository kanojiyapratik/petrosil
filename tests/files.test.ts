/**
 * Files: where they live, how the old ones come across, who may open which,
 * and uploading new ones.
 *
 * The old sites kept everything under `file_manager/<area>/<folder>/<name>`
 * on each server — about 14 GB across the nine — and content rows hold the
 * bare name ("584.pdf"). The key here keeps that shape under the brand:
 * `baseoil/reports/files/584.pdf`, so a carried row finds its file without
 * being rewritten.
 *
 * Public folders (article and ad images, thumbnails) are served to anyone.
 * Report PDFs, trade sheets and attachments are paid content and are not:
 * they wait for a download that checks the paywall.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { articles, mediaFiles, reports, users } from "@/db/schema";
import { diskStore, s3Store, InvalidKey, type FileStore } from "@/lib/files/store";
import { importFiles } from "@/domain/files/import";
import { openFile, readPublicFile, uploadFile, MAX_UPLOAD_BYTES } from "@/domain/files/access";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let root: string;
let store: FileStore;
let baseoil: Brand;
let bitumart: Brand;

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);
  root = await mkdtemp(join(tmpdir(), "petrosil-files-"));
  store = diskStore(join(root, "store"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const bytes = (text: string) => new TextEncoder().encode(text);

async function text(body: Uint8Array | null | undefined) {
  return body ? new TextDecoder().decode(body) : null;
}

/** Stores must agree on behaviour, whatever is behind them. */
function behavesLikeAStore(make: () => FileStore) {
  it("keeps what it is given and hands it back", async () => {
    const s = make();

    await s.put("baseoil/reports/files/584.pdf", bytes("%PDF report"), "application/pdf");

    expect(await s.exists("baseoil/reports/files/584.pdf")).toBe(true);

    const got = await s.get("baseoil/reports/files/584.pdf");

    expect(await text(got?.body)).toBe("%PDF report");
    expect(got?.bytes).toBe(11);

    await s.delete("baseoil/reports/files/584.pdf");

    expect(await s.exists("baseoil/reports/files/584.pdf")).toBe(false);
    expect(await s.get("baseoil/reports/files/584.pdf")).toBeNull();
  });

  it("accepts the names the old sites really used", async () => {
    const s = make();
    const key = "baseoil/reports/files/Petrosil Base Oil Report – February 01, 2020.pdf";

    await s.put(key, bytes("%PDF"), "application/pdf");

    expect(await s.exists(key)).toBe(true);
  });

  it("refuses a key that could reach outside its own place", async () => {
    const s = make();

    for (const key of ["../etc/passwd", "baseoil/../../x", "/abs/path", "baseoil\\x", "baseoil//x", "baseoil/.env", ""]) {
      await expect(s.put(key, bytes("x"), "text/plain")).rejects.toBeInstanceOf(InvalidKey);
    }
  });
}

describe("the disk store", () => {
  behavesLikeAStore(() => store);
});

describe.runIf(process.env.S3_TEST_ENDPOINT)("the S3-compatible store", () => {
  behavesLikeAStore(() =>
    s3Store({
      endpoint: process.env.S3_TEST_ENDPOINT!,
      bucket: process.env.S3_TEST_BUCKET ?? "petrosil-test",
      accessKeyId: process.env.S3_TEST_KEY ?? "minioadmin",
      secretAccessKey: process.env.S3_TEST_SECRET ?? "minioadmin",
      region: "auto",
      forcePathStyle: true,
    }),
  );
});

describe("carrying an old site's files", () => {
  async function oldSite() {
    const from = join(root, "file_manager");

    for (const [path, body] of [
      ["reports/files/584.pdf", "%PDF report"],
      ["articles/thumbnail/19081.jpg", "jpeg"],
      ["ads/images/71.jpg", "ad"],
      ["junk/notes.txt", "?"],
      ["reports/files/Thumbs.db", "windows litter"],
    ] as const) {
      await mkdir(join(from, path, ".."), { recursive: true });
      await writeFile(join(from, path), body);
    }

    return from;
  }

  it("copies the known folders in, indexes each file, and says what it left", async () => {
    const result = await importFiles({ site: "baseoil", from: await oldSite(), store });

    expect(result.imported).toBe(3);
    expect(result.unknown).toEqual(["junk/notes.txt"]);

    expect(await text((await store.get("baseoil/reports/files/584.pdf"))?.body)).toBe("%PDF report");

    const rows = await db().select().from(mediaFiles).orderBy(mediaFiles.path);

    expect(rows.map((row) => [row.path, row.folder, row.kind, row.bytes])).toEqual([
      ["baseoil/ads/images/71.jpg", "ads/images", "image/jpeg", 2],
      ["baseoil/articles/thumbnail/19081.jpg", "articles/thumbnail", "image/jpeg", 4],
      ["baseoil/reports/files/584.pdf", "reports/files", "application/pdf", 11],
    ]);
    expect(rows.every((row) => row.siteId === baseoil.siteId)).toBe(true);
  });

  it("can be run again without copying anything twice", async () => {
    const from = await oldSite();

    await importFiles({ site: "baseoil", from, store });
    const again = await importFiles({ site: "baseoil", from, store });

    expect(again.imported).toBe(0);
    expect(again.alreadyHere).toBe(3);
    expect(await db().select().from(mediaFiles)).toHaveLength(3);
  });

  it("lists content that names a file the old site did not have", async () => {
    await db().insert(reports).values([
      { siteId: baseoil.siteId, slug: "a", title: "Here", reportType: "monthly", file: "584.pdf" },
      { siteId: baseoil.siteId, slug: "b", title: "Gone", reportType: "monthly", file: "999.pdf" },
    ]);
    await db().insert(articles).values({ siteId: baseoil.siteId, slug: "x", title: "X", body: "x", heroImage: "404.jpg" });

    const result = await importFiles({ site: "baseoil", from: await oldSite(), store });

    expect(result.missing).toEqual(["articles/thumbnail/404.jpg", "reports/files/999.pdf"]);
  });
});

describe("who may open what", () => {
  beforeEach(async () => {
    await store.put("baseoil/articles/thumbnail/19081.jpg", bytes("jpeg"), "image/jpeg");
    await store.put("baseoil/reports/files/584.pdf", bytes("%PDF"), "application/pdf");
    await db().insert(mediaFiles).values([
      { siteId: baseoil.siteId, path: "baseoil/articles/thumbnail/19081.jpg", folder: "articles/thumbnail", name: "19081.jpg", kind: "image/jpeg", bytes: 4 },
      { siteId: baseoil.siteId, path: "baseoil/reports/files/584.pdf", folder: "reports/files", name: "584.pdf", kind: "application/pdf", bytes: 4 },
    ]);
  });

  it("serves a public image to anyone", async () => {
    const file = await readPublicFile("baseoil", "articles/thumbnail/19081.jpg", store);

    expect(file?.contentType).toBe("image/jpeg");
    expect(await text(file?.body)).toBe("jpeg");
  });

  it("does not serve paid files, other brands' files, or paths that wander", async () => {
    expect(await readPublicFile("baseoil", "reports/files/584.pdf", store)).toBeNull();
    expect(await readPublicFile("bitumart", "articles/thumbnail/19081.jpg", store)).toBeNull();
    expect(await readPublicFile("baseoil", "articles/thumbnail/../../reports/files/584.pdf", store)).toBeNull();
    expect(await readPublicFile("baseoil", "articles/thumbnail/nope.jpg", store)).toBeNull();
  });

  it("lets a brand's staff open any of its files, paid ones included, and nobody else's", async () => {
    const [row] = await db().select().from(mediaFiles).where(eq(mediaFiles.path, "baseoil/reports/files/584.pdf"));

    const mine = await openFile({ siteIds: [baseoil.siteId], isSuperadmin: false } as never, row!.id, store);

    expect(await text(mine?.body)).toBe("%PDF");
    expect(await openFile({ siteIds: [bitumart.siteId], isSuperadmin: false } as never, row!.id, store)).toBeNull();
  });
});

describe("uploading", () => {
  let staff: number;

  const guard = (siteIds: number[]) =>
    ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

  beforeEach(async () => {
    const [row] = await db().insert(users).values({ email: "staff@petrosil.example", name: "Staff" }).returning();

    staff = row!.id;
  });

  it("stores the file under a name that cannot collide, and records who sent it", async () => {
    const one = await uploadFile(guard([baseoil.siteId]), {
      site: "baseoil",
      folder: "reports/files",
      name: "October Report 2026.PDF",
      type: "application/pdf",
      body: bytes("%PDF-1.7"),
    }, store);
    const two = await uploadFile(guard([baseoil.siteId]), {
      site: "baseoil",
      folder: "reports/files",
      name: "October Report 2026.PDF",
      type: "application/pdf",
      body: bytes("%PDF-1.7"),
    }, store);

    expect(one.ok && two.ok).toBe(true);

    const [a, b] = [one, two] as { ok: true; name: string; path: string }[];

    expect(a!.name).toMatch(/^october-report-2026-[a-z0-9]{6}\.pdf$/);
    expect(a!.name).not.toBe(b!.name);
    expect(await store.exists(a!.path)).toBe(true);

    const [row] = await db().select().from(mediaFiles).where(eq(mediaFiles.path, a!.path));

    expect(row).toMatchObject({ siteId: baseoil.siteId, folder: "reports/files", uploadedBy: staff, bytes: 8 });
  });

  it("refuses a file type it does not serve", async () => {
    const result = await uploadFile(guard([]), {
      site: "baseoil",
      folder: "reports/files",
      name: "setup.exe",
      type: "application/x-msdownload",
      body: bytes("MZ"),
    }, store);

    expect(result.ok).toBe(false);
  });

  it("refuses a file that is too big", async () => {
    const result = await uploadFile(guard([]), {
      site: "baseoil",
      folder: "reports/files",
      name: "huge.pdf",
      type: "application/pdf",
      body: new Uint8Array(MAX_UPLOAD_BYTES + 1),
    }, store);

    expect(result.ok).toBe(false);
  });

  it("refuses a folder that does not exist, and another brand", async () => {
    const odd = await uploadFile(guard([]), {
      site: "baseoil",
      folder: "../secrets",
      name: "a.pdf",
      type: "application/pdf",
      body: bytes("%PDF"),
    }, store);
    const theirs = await uploadFile(guard([baseoil.siteId]), {
      site: "bitumart",
      folder: "reports/files",
      name: "a.pdf",
      type: "application/pdf",
      body: bytes("%PDF"),
    }, store);

    expect(odd.ok).toBe(false);
    expect(theirs.ok).toBe(false);
  });
});
