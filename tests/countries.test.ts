/**
 * The country list, and countries held to it.
 *
 * Which plans a reader is offered, and in which currency, is read off the
 * country on their profile, so it has to be one the rule can recognise.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { users } from "@/db/schema";
import { COUNTRIES, findCountry } from "@/domain/geo/countries";
import { readCountry, register } from "@/domain/accounts/register";
import { updateProfile } from "@/domain/accounts/profile";
import { GET as countriesRoute } from "@/app/api/public/countries/route";
import { makeBrand, resetDatabase } from "./helpers";

describe("the list", () => {
  it("is the old sites' 246 countries, each with a code and a dialling code", () => {
    expect(COUNTRIES).toHaveLength(246);
    expect(findCountry("India")).toEqual({ name: "India", code: "IN", dial_code: 91 });
    expect(findCountry("np")).toMatchObject({ name: "Nepal", dial_code: 977 });
  });

  it("repairs the old spellings of South Korea", () => {
    expect(findCountry("South Korea")?.code).toBe("KR");
    expect(findCountry("Korea South")?.name).toBe("South Korea");
    expect(findCountry("  south   korea ")?.name).toBe("South Korea");
  });

  it("does not take a near name for a country", () => {
    expect(findCountry("Indian")).toBeNull();
    expect(findCountry("")).toBeNull();
  });

  it("is served at /api/public/countries", async () => {
    const body = await (await countriesRoute(new Request("http://platform.test/api/public/countries"))).json();

    expect(body.countries).toHaveLength(246);
  });
});

describe("a country on a profile", () => {
  beforeEach(async () => {
    await resetDatabase();
    await makeBrand("baseoil", []);
  });

  it("is stored by its name, whatever case or code it was sent in", () => {
    expect(readCountry("nepal")).toBe("Nepal");
    expect(readCountry("LK")).toBe("Sri Lanka");
    expect(readCountry("  ")).toBeNull();
    expect(() => readCountry("Narnia")).toThrow(/from the list/);
  });

  it("is checked at sign-up", async () => {
    const input = { site: "baseoil", email: "a@b.example", password: "a long pass phrase 9", name: "A" };

    await expect(register({ ...input, country: "Narnia" })).rejects.toMatchObject({ field: "country" });
    await register({ ...input, country: "np" });

    const [person] = await db().select().from(users).where(eq(users.email, "a@b.example"));

    expect(person!.country).toBe("Nepal");
  });

  it("is checked when a reader edits their profile", async () => {
    const [person] = await db().insert(users).values({ email: "c@d.example", name: "C" }).returning();

    await expect(updateProfile(person!.id, { country: "Atlantis" })).rejects.toMatchObject({ field: "country" });
    expect((await updateProfile(person!.id, { country: "bangladesh" })).country).toBe("Bangladesh");
  });
});
