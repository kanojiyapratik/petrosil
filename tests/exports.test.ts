/**
 * The people lists the team downloads: all, free, premium, expired premium
 * and trial, one brand at a time, as the old admin's five Excel exports did.
 *
 * The old ones read `users.premium`, a flag a cron job flipped, so "expired"
 * meant whatever the job last got round to. Here the list is worked out from
 * the membership and today's date when it is asked for.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { GET as exportRoute } from "@/app/api/dashboard/exports/people/route";
import { db } from "@/db";
import { auditLog, memberships, rolePermissions, roles, users } from "@/db/schema";
import { AccessError } from "@/lib/auth/guard";
import { EXPORT_SEGMENTS, csvCell, peopleCsv } from "@/domain/clients/export";
import { addDays } from "@/domain/billing/sweep";
import { today } from "@/domain/price/dates";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let staff: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

const TODAY = today();

async function person(
  email: string,
  brand: Brand,
  tier: string,
  values: { expiresAt?: string | null; status?: string; role?: string; name?: string; company?: string } = {},
) {
  const [row] = await db()
    .insert(users)
    .values({
      email,
      name: values.name ?? email.split("@")[0]!,
      status: values.status ?? "active",
      company: values.company ?? null,
    })
    .returning();

  await db()
    .insert(memberships)
    .values({
      userId: row!.id,
      siteId: brand.siteId,
      tier,
      role: values.role ?? "subscriber",
      expiresAt: values.expiresAt ?? null,
    });

  return row!.id;
}

/** The CSV as rows of cells, without the byte-order mark. */
function parse(body: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const text = body.replace(/^﻿/, "");

  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;

    if (quoted) {
      if (char === '"' && text[at + 1] === '"') {
        cell += '"';
        at += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  return rows;
}

const emails = (rows: string[][]) => rows.slice(1).map((row) => row[2]).sort();

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  const [me] = await db().insert(users).values({ email: "boss@petrosil.example", name: "Boss" }).returning();

  staff = me!.id;

  await person("paying@x.example", baseoil, "premium", { expiresAt: addDays(TODAY, 30) });
  await person("open-ended@x.example", baseoil, "premium");
  await person("lapsed@x.example", baseoil, "premium", { expiresAt: addDays(TODAY, -1) });
  await person("trying@x.example", baseoil, "trial", { expiresAt: addDays(TODAY, 5) });
  await person("tried@x.example", baseoil, "trial", { expiresAt: addDays(TODAY, -5) });
  await person("free@x.example", baseoil, "free");
  await person("other-brand@x.example", bitumart, "premium");
  await person("closed@x.example", baseoil, "premium", { status: "inactive" });
  await person("staffer@x.example", baseoil, "free", { role: "staff" });
});

describe("the lists", () => {
  it("offers the old admin's five, plus lapsed trials", () => {
    expect(EXPORT_SEGMENTS.map((segment) => segment.key)).toEqual([
      "all",
      "free",
      "premium",
      "expired",
      "trial",
      "trial_expired",
    ]);
  });

  it("sorts readers by their standing on this brand today", async () => {
    const list = async (segment: string) =>
      emails(parse((await peopleCsv(guard([]), { site: "baseoil", segment })).body));

    expect(await list("premium")).toEqual(["open-ended@x.example", "paying@x.example"]);
    expect(await list("expired")).toEqual(["lapsed@x.example"]);
    expect(await list("trial")).toEqual(["trying@x.example"]);
    expect(await list("trial_expired")).toEqual(["tried@x.example"]);
    expect(await list("free")).toEqual(["free@x.example"]);
  });

  it("leaves out staff, closed accounts and other brands' readers", async () => {
    const all = emails(parse((await peopleCsv(guard([]), { site: "baseoil", segment: "all" })).body));

    expect(all).toHaveLength(6);
    expect(all).not.toContain("staffer@x.example");
    expect(all).not.toContain("closed@x.example");
    expect(all).not.toContain("other-brand@x.example");
  });

  it("names the file after the brand, the list and the day", async () => {
    const made = await peopleCsv(guard([]), { site: "baseoil", segment: "expired" });

    expect(made.filename).toBe(`baseoil-expired-premium-${TODAY}.csv`);
    expect(made.rows).toBe(1);
  });

  it("refuses a list it does not know", async () => {
    await expect(peopleCsv(guard([]), { site: "baseoil", segment: "vip" })).rejects.toMatchObject({ status: 422 });
  });
});

describe("the file", () => {
  it("has the columns the team's spreadsheets expect", async () => {
    const [heading] = parse((await peopleCsv(guard([]), { site: "baseoil", segment: "all" })).body);

    expect(heading).toEqual([
      "Membership",
      "Name",
      "Email",
      "Phone",
      "Company",
      "Designation",
      "Address",
      "City",
      "Country",
      "Postcode",
      "Website",
      "Expires",
      "Joined",
    ]);
  });

  it("starts with a byte-order mark so Excel reads names in any script", async () => {
    const { body } = await peopleCsv(guard([]), { site: "baseoil", segment: "all" });

    expect(body.startsWith("﻿")).toBe(true);
  });

  it("survives commas, quotes and line breaks in a field", async () => {
    await person("awkward@x.example", baseoil, "free", { company: 'Oil, "Gas"\nand Co' });

    const rows = parse((await peopleCsv(guard([]), { site: "baseoil", segment: "free" })).body);
    const awkward = rows.find((row) => row[2] === "awkward@x.example")!;

    expect(awkward[4]).toBe('Oil, "Gas"\nand Co');
  });

  it("does not let a field run as a spreadsheet formula", async () => {
    // A member can type anything into their company name.
    await person("formula@x.example", baseoil, "free", { company: '=HYPERLINK("http://evil.example","x")' });

    const rows = parse((await peopleCsv(guard([]), { site: "baseoil", segment: "free" })).body);
    const row = rows.find((cells) => cells[2] === "formula@x.example")!;

    expect(row[4]!.startsWith("'=")).toBe(true);
  });

  it("leaves a phone number as it was typed", () => {
    expect(csvCell("+91 98200 12345")).toBe("+91 98200 12345");
    expect(csvCell("+1 (212) 555-0100")).toBe("+1 (212) 555-0100");
    expect(csvCell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
  });
});

describe("who may download it", () => {
  it("not staff of another brand", async () => {
    await expect(peopleCsv(guard([bitumart.siteId]), { site: "baseoil", segment: "all" })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("not a role without 'see people'", async () => {
    const [role] = await db().insert(roles).values({ name: "Writer" }).returning();

    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "article-create" });
    await db().insert(memberships).values({ userId: staff, siteId: baseoil.siteId, role: "staff", roleId: role!.id });

    await expect(peopleCsv(guard([baseoil.siteId]), { site: "baseoil", segment: "all" })).rejects.toBeInstanceOf(
      AccessError,
    );
  });

  it("is recorded, because it is the customer list leaving the building", async () => {
    await peopleCsv(guard([]), { site: "baseoil", segment: "premium" }, { ip: "10.0.0.1" });

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "people.export"));

    expect(entry).toMatchObject({ siteId: baseoil.siteId, userId: staff, ip: "10.0.0.1" });
    expect(entry!.detail).toMatchObject({ segment: "premium", rows: 2 });
  });
});

describe("the download", () => {
  it("needs a signed-in team member", async () => {
    const response = await exportRoute(
      new Request("http://localhost/api/dashboard/exports/people?site=baseoil&segment=all") as never,
      { params: Promise.resolve({}) } as never,
    );

    expect(response.status).toBe(401);
  });
});
