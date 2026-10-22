/**
 * Writing the announcement strip.
 *
 * The strip is the most time-sensitive thing on a brand site and the old
 * schema put no constraint on its window at all, so a notice could be saved
 * with an end before its start and simply never appear. Nobody would see a
 * mistake like that: an announcement that does not show looks exactly like
 * an announcement nobody wrote.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { announcements, auditLog, users } from "@/db/schema";
import { makeBrand, resetDatabase, type Brand } from "./helpers";
import { removeAnnouncement, saveAnnouncement } from "@/domain/content/pages";

let baseoil: Brand;
let bitumart: Brand;
// A real row: every write here lands an audit entry, and that entry carries a
// foreign key to the person who made it.
let actor: number;

const guard = (siteIds: number[]) => ({
  identity: { user: { id: actor }, memberships: [] },
  siteIds,
  isSuperadmin: siteIds.length === 0,
});

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  const [row] = await db()
    .insert(users)
    .values({ email: "editor@petrosil.example", name: "An Editor" })
    .returning();

  actor = row!.id;
});

describe("saving an announcement", () => {
  it("writes one and records who wrote it", async () => {
    const saved = await saveAnnouncement(guard([]) as never, {
      site: "baseoil",
      body: "The 24 October report is out.",
      link: "https://baseoilreport.com/reports",
      starts_at: "2026-10-24",
      ends_at: "2026-10-31",
      enabled: true,
    });

    expect(saved.ok).toBe(true);

    const [row] = await db().select().from(announcements);

    expect(row!.body).toBe("The 24 October report is out.");
    expect(row!.startsAt).toBe("2026-10-24");
    expect(row!.endsAt).toBe("2026-10-31");

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "announcement.save"));

    expect(entry).toBeDefined();
  });

  it("refuses a notice with nothing to say", async () => {
    const result = await saveAnnouncement(guard([]) as never, {
      site: "baseoil",
      body: "   ",
    });

    expect(result).toMatchObject({ ok: false, field: "body" });
    expect(await db().select().from(announcements)).toHaveLength(0);
  });

  it("refuses a window that can never open", async () => {
    // The old schema allowed it, and the notice then looks identical to one
    // nobody ever wrote: invisible, with no complaint anywhere.
    const result = await saveAnnouncement(guard([]) as never, {
      site: "baseoil",
      body: "Back to front.",
      starts_at: "2026-10-31",
      ends_at: "2026-10-24",
    });

    expect(result).toMatchObject({ ok: false, field: "ends_at" });
    expect(await db().select().from(announcements)).toHaveLength(0);
  });

  it("allows a window open at both ends, which means until further notice", async () => {
    const result = await saveAnnouncement(guard([]) as never, {
      site: "baseoil",
      body: "Standing notice.",
    });

    expect(result.ok).toBe(true);

    const [row] = await db().select().from(announcements);

    expect(row!.startsAt).toBeNull();
    expect(row!.endsAt).toBeNull();
  });

  it("refuses a brand the viewer was not granted", async () => {
    const result = await saveAnnouncement(guard([baseoil.siteId]) as never, {
      site: "bitumart",
      body: "Not mine to post.",
    });

    expect(result).toMatchObject({ ok: false, field: "site" });
    expect(await db().select().from(announcements)).toHaveLength(0);
  });

  it("edits an existing one in place rather than adding a second", async () => {
    const made = await saveAnnouncement(guard([]) as never, {
      site: "baseoil",
      body: "First wording.",
    });

    await saveAnnouncement(guard([]) as never, {
      id: made.id,
      site: "baseoil",
      body: "Better wording.",
      enabled: false,
    });

    const rows = await db().select().from(announcements);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe("Better wording.");
    expect(rows[0]!.enabled).toBe(false);
  });

  it("will not let one brand edit another brand's notice through its id", async () => {
    const theirs = await saveAnnouncement(guard([]) as never, {
      site: "bitumart",
      body: "Bitumart's own.",
    });

    const result = await saveAnnouncement(guard([baseoil.siteId]) as never, {
      id: theirs.id,
      site: "baseoil",
      body: "Hijacked.",
    });

    expect(result.ok).toBe(false);

    const [row] = await db().select().from(announcements).where(eq(announcements.id, theirs.id!));

    expect(row!.body).toBe("Bitumart's own.");
  });
});

describe("removing an announcement", () => {
  it("takes it off the site and records it", async () => {
    const made = await saveAnnouncement(guard([]) as never, {
      site: "baseoil",
      body: "Temporary.",
    });

    expect(await removeAnnouncement(guard([]) as never, made.id!)).toBe(true);
    expect(await db().select().from(announcements)).toHaveLength(0);

    const [entry] = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "announcement.remove"));

    expect(entry).toBeDefined();
  });

  it("refuses another brand's", async () => {
    const theirs = await saveAnnouncement(guard([]) as never, {
      site: "bitumart",
      body: "Theirs.",
    });

    expect(await removeAnnouncement(guard([baseoil.siteId]) as never, theirs.id!)).toBe(false);
    expect(await db().select().from(announcements)).toHaveLength(1);
  });
});
