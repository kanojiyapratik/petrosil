/**
 * The decisions the migration makes, tested on the shapes the real dumps
 * actually contain — zero dates, case-duplicate emails, soft-deleted prices,
 * two live prices for one cell.
 */
import { describe, expect, it } from "vitest";

import {
  dedupeByEmail,
  dedupePrices,
  readDate,
  readDay,
  readUser,
  type LegacyPrice,
  type LegacyUser,
} from "@/domain/migrate/transform";

const USER: LegacyUser = {
  id: 1,
  email: "person@company.example",
  name: "A Person",
  first_name: null,
  last_name: null,
  company_name: "Company Ltd",
  mobile: "+91 00000 00000",
  country: "India",
  premium: 0,
  user_status: "Active",
  isAdmin: 0,
  expiry_date: null,
  created_at: "2019-04-02 10:00:00",
  updated_at: "2024-01-01 10:00:00",
  password: "$2y$10$uSig3UJl1f23F7eisTeaq.UcUflvEE0cgw8bcfl1jHhcJZKSwznYe",
  email_verified_at: "2019-04-02 10:05:00",
  deleted_at: null,
};

const user = (over: Partial<LegacyUser>): LegacyUser => ({ ...USER, ...over });

describe("reading a legacy date", () => {
  it("refuses MySQL's zero date, which is not a date", () => {
    expect(readDate("0000-00-00 00:00:00")).toBeNull();
    expect(readDate("0000-00-00")).toBeNull();
    expect(readDay("0000-00-00")).toBeNull();
  });

  it("reads a real one, and nothing from an empty cell", () => {
    expect(readDay("2026-10-16 09:30:00")).toBe("2026-10-16");
    expect(readDate(null)).toBeNull();
    expect(readDate("")).toBeNull();
  });
});

describe("reading a person", () => {
  it("keeps the bcrypt hash exactly as the site wrote it", () => {
    // Rewriting it would lock 112,000 people out of their own accounts.
    expect(readUser(USER).passwordHash).toBe(USER.password);
  });

  it("falls back to updated_at when created_at is a zero date", () => {
    const migrated = readUser(user({ created_at: "0000-00-00 00:00:00" }));

    expect(migrated.createdAt.getFullYear()).toBe(2024);
  });

  it("builds a name when the name column is empty", () => {
    expect(readUser(user({ name: "", first_name: "Rahul", last_name: "Menon" })).name).toBe(
      "Rahul Menon",
    );
    expect(readUser(user({ name: null, first_name: null, last_name: null })).name).toBe("person");
  });

  it("carries a lapsed subscription as premium with a past expiry", () => {
    // Not as "free": the fact that they paid until August is what a renewal
    // conversation starts from, and it is how the dashboard reads "expired".
    const migrated = readUser(user({ premium: 1, expiry_date: "2025-08-12" }));

    expect(migrated.tier).toBe("premium");
    expect(migrated.expiresAt).toBe("2025-08-12");
  });

  it("notes an old admin without granting anything", () => {
    expect(readUser(user({ isAdmin: 1 })).wasAdmin).toBe(true);
  });

  it("disables an account the old site had suspended", () => {
    expect(readUser(user({ user_status: "Inactive" })).status).toBe("disabled");
    expect(readUser(user({ user_status: "Active" })).status).toBe("active");
  });
});

describe("collapsing duplicate email addresses", () => {
  it("merges rows that differ only by case", () => {
    const { kept, merged } = dedupeByEmail([
      readUser(user({ id: 1, email: "Rahul@Company.example" })),
      readUser(user({ id: 2, email: "rahul@company.example" })),
    ]);

    expect(kept).toHaveLength(1);
    expect(merged).toBe(1);
    expect(kept[0]!.legacyIds).toEqual([1, 2]);
  });

  it("keeps the subscription when only one of the rows had it", () => {
    const { kept } = dedupeByEmail([
      readUser(user({ id: 1, premium: 0, created_at: "2024-01-01 00:00:00" })),
      readUser(user({ id: 2, premium: 1, expiry_date: "2027-01-01", created_at: "2019-01-01 00:00:00" })),
    ]);

    // Dropping a subscription someone paid for is the one merge mistake that
    // costs money, so paying always wins — even on the older row.
    expect(kept[0]!.tier).toBe("premium");
    expect(kept[0]!.expiresAt).toBe("2027-01-01");
  });

  it("does not read a free row's empty expiry as premium-for-ever", () => {
    // The bug this pins: a free duplicate has no expiry either, and treating
    // that null as "no end date" handed the merged account open-ended premium.
    const { kept } = dedupeByEmail([
      readUser(user({ id: 1, premium: 0, expiry_date: null })),
      readUser(user({ id: 2, premium: 1, expiry_date: "2027-01-01" })),
    ]);

    expect(kept[0]!.tier).toBe("premium");
    expect(kept[0]!.expiresAt).toBe("2027-01-01");
  });

  it("keeps the furthest expiry, and treats no expiry as the furthest of all", () => {
    const withDates = dedupeByEmail([
      readUser(user({ id: 1, premium: 1, expiry_date: "2026-01-01" })),
      readUser(user({ id: 2, premium: 1, expiry_date: "2028-01-01" })),
    ]);
    expect(withDates.kept[0]!.expiresAt).toBe("2028-01-01");

    const openEnded = dedupeByEmail([
      readUser(user({ id: 1, premium: 1, expiry_date: "2026-01-01" })),
      readUser(user({ id: 2, premium: 1, expiry_date: null })),
    ]);
    expect(openEnded.kept[0]!.expiresAt).toBeNull();
  });

  it("keeps a password and a verification from whichever row had one", () => {
    const { kept } = dedupeByEmail([
      readUser(user({ id: 1, password: null, email_verified_at: null, created_at: "2024-01-01 00:00:00" })),
      readUser(user({ id: 2, created_at: "2019-01-01 00:00:00" })),
    ]);

    expect(kept[0]!.passwordHash).toBe(USER.password);
    expect(kept[0]!.emailVerifiedAt).not.toBeNull();
  });

  it("takes the earliest joining date, because that is when they joined", () => {
    const { kept } = dedupeByEmail([
      readUser(user({ id: 1, created_at: "2024-01-01 00:00:00" })),
      readUser(user({ id: 2, created_at: "2016-06-06 00:00:00" })),
    ]);

    expect(kept[0]!.createdAt.getFullYear()).toBe(2016);
  });

  it("leaves genuinely different people alone", () => {
    const { kept, merged } = dedupeByEmail([
      readUser(user({ id: 1, email: "one@company.example" })),
      readUser(user({ id: 2, email: "two@company.example" })),
    ]);

    expect(kept).toHaveLength(2);
    expect(merged).toBe(0);
  });
});

describe("collapsing prices", () => {
  const price = (over: Partial<LegacyPrice>): LegacyPrice => ({
    id: 1,
    location_id: 10,
    pricedate: "2026-10-16",
    price: 1500,
    currency_id: 2,
    deleted_at: null,
    ...over,
  });

  it("leaves soft-deleted rows behind", () => {
    const result = dedupePrices([
      price({ id: 1 }),
      price({ id: 2, deleted_at: "2026-01-01 00:00:00", pricedate: "2026-10-09" }),
    ]);

    expect(result.kept).toHaveLength(1);
    expect(result.softDeleted).toBe(1);
  });

  it("keeps the newest row when two live prices share a location and date", () => {
    const result = dedupePrices([
      price({ id: 7, price: 1500 }),
      price({ id: 9, price: 1545 }),
      price({ id: 8, price: 1510 }),
    ]);

    // Same rule the differ uses for "the current price": highest id wins.
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.price).toBe(1545);
    expect(result.collisions).toBe(2);
  });

  it("drops a row with no usable date rather than parking it on the epoch", () => {
    const result = dedupePrices([
      price({ id: 1, pricedate: "0000-00-00" }),
      price({ id: 2, pricedate: null }),
      price({ id: 3 }),
    ]);

    expect(result.kept).toHaveLength(1);
    expect(result.undated).toBe(2);
    expect(result.priceless).toBe(0);
  });

  it("counts a row with no price separately from a row with no date", () => {
    // baseoil has 11,105 of the first and none of the second, and a report
    // that called them all "undated" would send someone hunting a date
    // problem that does not exist.
    const result = dedupePrices([
      price({ id: 1, price: null }),
      price({ id: 2, pricedate: "0000-00-00", location_id: 11 }),
      price({ id: 3, location_id: 12 }),
    ]);

    expect(result.priceless).toBe(1);
    expect(result.undated).toBe(1);
    expect(result.kept).toHaveLength(1);
  });

  it("keeps the same location's other dates", () => {
    const result = dedupePrices([
      price({ id: 1, pricedate: "2026-10-16" }),
      price({ id: 2, pricedate: "2026-10-09" }),
      price({ id: 3, pricedate: "2026-10-02" }),
    ]);

    expect(result.kept).toHaveLength(3);
    expect(result.collisions).toBe(0);
  });
});

describe("prices that cannot be believed", () => {
  it("sets aside a negative price and an absurd one, rather than clamping either", () => {
    // Both are real: baseoil carries a 2018 row reading 8.06e24 and one at -1.
    const result = dedupePrices([
      { id: 1, location_id: 10, pricedate: "2026-10-16", price: 1500, currency_id: 2, deleted_at: null },
      { id: 2, location_id: 11, pricedate: "2018-04-01", price: 8.05855e24, currency_id: 2, deleted_at: null },
      { id: 3, location_id: 12, pricedate: "2019-01-01", price: -1, currency_id: 2, deleted_at: null },
    ]);

    expect(result.kept).toHaveLength(1);
    expect(result.outOfRange.map((row) => row.id)).toEqual([3, 2]);
  });
});
