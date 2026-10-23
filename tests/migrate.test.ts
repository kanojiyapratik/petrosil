/**
 * The decisions the migration makes, tested on the shapes the real dumps
 * actually contain — zero dates, case-duplicate emails, soft-deleted prices,
 * two live prices for one cell.
 */
import { describe, expect, it } from "vitest";

import {
  blanksToFill,
  columnList,
  readExpiry,
  tierFor,
  dedupeByEmail,
  dedupePrices,
  readDate,
  readDay,
  readUser,
  withProfile,
  type LegacyPrice,
  type LegacyProfile,
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

/**
 * Three dumps of the nine have a `mobile` column holding pasted spam, and
 * two were built before `locations.show_on_dashboard` existed. Both stopped
 * a migration dead the first time it was run across the whole estate.
 */
describe("fields the old schema let overflow", () => {
  it("drops a phone number that cannot be one, rather than truncating it", () => {
    const junk =
      "Thank you so much for this newsletter Thank you so much for this newsletter 2994386 https://t.me !";

    expect(readUser(user({ mobile: junk })).phone).toBeNull();
  });

  it("keeps a phone number that fits", () => {
    expect(readUser(user({ mobile: "+91 22 2345 6789" })).phone).toBe("+91 22 2345 6789");
  });

  it("trims an over-long name to what the column holds", () => {
    const long = "A".repeat(400);

    expect(readUser(user({ name: long })).name).toHaveLength(191);
  });

  it("trims an over-long company and country the same way", () => {
    const read = readUser(user({ company_name: "C".repeat(400), country: "D".repeat(400) }));

    expect(read.company).toHaveLength(191);
    expect(read.country).toHaveLength(96);
  });
});

describe("selecting columns a dump may not have", () => {
  it("asks for the column when the dump has it", () => {
    expect(columnList(["id", "title", "show_on_dashboard"], ["id", "title", "show_on_dashboard"])).toBe(
      "id, title, show_on_dashboard",
    );
  });

  it("substitutes null for one the dump never had, keeping the name", () => {
    expect(columnList(["id", "title", "show_on_dashboard"], ["id", "title"])).toBe(
      "id, title, null as show_on_dashboard",
    );
  });
});

/**
 * What `premium` and the expiry date actually mean.
 *
 * Measured against baseoilreport on 2026-10-23, and read out of the old
 * site's own `DirectoryController::listDirectory`, which branches on four
 * values: 1 is paying, 2 is lapsed, 3 is a trial, 0 is free. The first cut
 * of this migration read the column as a boolean, so 146 lapsed and 29 trial
 * users on baseoil alone arrived as free.
 *
 * And the date never came from `users.expiry_date` — every row in that column
 * is NULL. The real dates are in `subscription_users`: 635 of them on
 * baseoil, 632 sane, one before 2000 and two after 2040.
 */
describe("the four states of the old premium column", () => {
  it("reads 1 as paying", () => {
    expect(tierFor(1)).toBe("premium");
  });

  it("reads 2 as someone who paid and lapsed", () => {
    // Not free: they are in the old site's "Expired Premium Users" list, and
    // the fact they once paid is the reason to chase them.
    expect(tierFor(2)).toBe("premium");
  });

  it("reads 3 as a trial", () => {
    expect(tierFor(3)).toBe("trial");
  });

  it("reads 0, and anything it does not recognise, as free", () => {
    expect(tierFor(0)).toBe("free");
    expect(tierFor(9)).toBe("free");
    expect(tierFor(null)).toBe("free");
  });
});

describe("an expiry date worth believing", () => {
  it("takes a sane date as it is", () => {
    expect(readExpiry("2026-12-31")).toBe("2026-12-31");
  });

  it("refuses a year nobody meant", () => {
    // baseoil carries one 0200-10-15 and two 2050-12-30. The first is a typo
    // that would read as "lapsed eighteen centuries ago"; the second is staff
    // writing "never", which an absent date already says.
    expect(readExpiry("0200-10-15")).toBeNull();
    expect(readExpiry("2050-12-30")).toBeNull();
  });

  it("still refuses the MySQL zero date", () => {
    expect(readExpiry("0000-00-00")).toBeNull();
  });
});

describe("reading a person with their subscription beside them", () => {
  it("gives a payer the expiry from their subscription, not the empty user column", () => {
    const read = readUser(user({ premium: 1, expiry_date: null }), "2027-03-31");

    expect(read.tier).toBe("premium");
    expect(read.expiresAt).toBe("2027-03-31");
  });

  it("gives a lapsed member a past date, so they read as expired and not as paying", () => {
    const read = readUser(user({ premium: 2, expiry_date: null }), "2024-06-30");

    expect(read.tier).toBe("premium");
    expect(read.expiresAt).toBe("2024-06-30");
  });

  it("falls back to when the row last changed for a lapsed member with no subscription", () => {
    // One user on baseoil. An absent date would read as open-ended premium --
    // showing a non-payer as paying, which is the worse of the two errors.
    const read = readUser(
      user({ premium: 2, expiry_date: null, updated_at: "2023-02-14 09:00:00" }),
      null,
    );

    expect(read.tier).toBe("premium");
    expect(read.expiresAt).toBe("2023-02-14");
  });

  it("leaves a payer with an unusable date open-ended rather than guessing", () => {
    const read = readUser(user({ premium: 1, expiry_date: null }), "2050-12-30");

    expect(read.tier).toBe("premium");
    expect(read.expiresAt).toBeNull();
  });

  it("never puts an expiry on a free account", () => {
    const read = readUser(user({ premium: 0, expiry_date: null }), "2024-06-30");

    expect(read.tier).toBe("free");
    expect(read.expiresAt).toBeNull();
  });
});

describe("the profile row the customer record actually lives in", () => {
  const PLACES = {
    countries: new Map([[101, "India"], [231, "United Arab Emirates"]]),
    cities: new Map([[8201, "Mumbai"], [9004, "Dubai"]]),
  };

  const PROFILE: LegacyProfile = {
    user_id: 1,
    company_name: "Profile Chemicals Pvt Ltd",
    designation: "Procurement Head",
    address1: "Unit 4, Andheri East",
    address2: "Mumbai 400069",
    pincode: "400069",
    city_id: 8201,
    country_id: 101,
    phone: "+91 22 4000 0000",
    mobile: null,
    website: "profilechem.example",
  };

  it("fills the fields the account row never carried", () => {
    // `users.country`, `users.city` and `users.designation` are empty on
    // every row in this estate. This is where they were.
    const person = withProfile(readUser({ ...USER, country: null, company_name: null }), PROFILE, PLACES);

    expect(person.country).toBe("India");
    expect(person.city).toBe("Mumbai");
    expect(person.company).toBe("Profile Chemicals Pvt Ltd");
    expect(person.designation).toBe("Procurement Head");
    expect(person.website).toBe("profilechem.example");
    expect(person.postcode).toBe("400069");
  });

  it("joins the two address lines", () => {
    expect(withProfile(readUser(USER), PROFILE, PLACES).address).toBe(
      "Unit 4, Andheri East, Mumbai 400069",
    );
  });

  it("leaves the account's own answer alone", () => {
    // The account is what the person signed up with; the profile fills the
    // blanks rather than overwriting them.
    const person = withProfile(readUser(USER), { ...PROFILE, country_id: 231 }, PLACES);

    expect(person.country).toBe("India");
    expect(person.company).toBe("Company Ltd");
  });

  it("resolves an id it has no name for to nothing, not to the id", () => {
    const person = withProfile(
      readUser({ ...USER, country: null }),
      { ...PROFILE, country_id: 777, city_id: 777 },
      PLACES,
    );

    expect(person.country).toBeNull();
    expect(person.city).toBeNull();
  });

  it("falls back to the mobile when the profile has no landline", () => {
    const person = withProfile(
      readUser({ ...USER, mobile: null }),
      { ...PROFILE, phone: null, mobile: "+91 98888 00000" },
      PLACES,
    );

    expect(person.phone).toBe("+91 98888 00000");
  });

  it("treats a blank as absent rather than writing an empty string", () => {
    const person = withProfile(
      readUser({ ...USER, company_name: null }),
      { ...PROFILE, company_name: "   ", address1: "", address2: null, pincode: "" },
      PLACES,
    );

    expect(person.company).toBeNull();
    expect(person.address).toBeNull();
    expect(person.postcode).toBeNull();
  });

  it("clips what the new columns are narrower than", () => {
    const person = withProfile(
      readUser({ ...USER, company_name: null }),
      { ...PROFILE, company_name: "C".repeat(400), pincode: "9".repeat(60) },
      PLACES,
    );

    expect(person.company).toHaveLength(191);
    expect(person.postcode).toHaveLength(32);
  });

  it("returns the person untouched when there is no profile", () => {
    const person = readUser(USER);

    expect(withProfile(person, undefined, PLACES)).toEqual(person);
  });
});

describe("backfilling a person who arrived from another brand", () => {
  // One person, one row, however many brands they read: whoever migrates
  // first creates them. Insert-only is what left the standings uncorrected
  // through three passes, and the profile fields would have gone the same
  // way -- the second brand knows the country the first brand missed.
  const held = {
    company: null,
    phone: null,
    country: null,
    city: null,
    designation: null,
    website: null,
    address: null,
    postcode: null,
  };

  it("fills only what the stored row is missing", () => {
    const fill = blanksToFill({ ...held, country: "India" }, {
      ...held,
      country: "United Arab Emirates",
      city: "Mumbai",
      company: "Chemicals Ltd",
    });

    expect(fill).toEqual({ city: "Mumbai", company: "Chemicals Ltd" });
  });

  it("asks for no update when the stored row already says everything", () => {
    expect(blanksToFill({ ...held, country: "India" }, { ...held, country: "Oman" })).toBeNull();
  });

  it("asks for no update when this brand knows nothing new", () => {
    expect(blanksToFill(held, held)).toBeNull();
  });
});
