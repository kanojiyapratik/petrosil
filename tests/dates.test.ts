import { describe, expect, it } from "vitest";

import { parseDate, today } from "@/domain/price/dates";

describe("reading a date", () => {
  it("takes the ISO form the module sends", () => {
    expect(parseDate("2026-10-16")).toBe("2026-10-16");
  });

  it("reads day-first dates, the house style on every Petrosil site", () => {
    expect(parseDate("03-10-2026")).toBe("2026-10-03");
    expect(parseDate("3/10/2026")).toBe("2026-10-03");
  });

  it("reads a written date", () => {
    expect(parseDate("5 October 2026")).toBe("2026-10-05");
    expect(parseDate("October 5, 2026")).toBe("2026-10-05");
  });

  it("refuses a bare number, which has no unambiguous date meaning", () => {
    // "45292" is a text-formatted Excel serial and "2026" is a year; both
    // would be silently misread as a time on today's date.
    expect(parseDate("45292")).toBeNull();
    expect(parseDate("2026")).toBeNull();
  });

  it("refuses a date that does not exist", () => {
    expect(parseDate("2026-02-30")).toBeNull();
    expect(parseDate("2026-13-01")).toBeNull();
  });

  it("refuses nonsense and nothing", () => {
    expect(parseDate("wednesday-ish")).toBeNull();
    expect(parseDate("")).toBeNull();
    expect(parseDate("   ")).toBeNull();
    expect(parseDate(null)).toBeNull();
    expect(parseDate(undefined)).toBeNull();
  });

  it("does not shift an ISO date across a timezone", () => {
    // The lock rule compares these strings against the local calendar day, so
    // a UTC-parsed midnight would move the date west of Greenwich.
    expect(parseDate("2026-01-01")).toBe("2026-01-01");
    expect(parseDate("2026-12-31")).toBe("2026-12-31");
  });

  it("reports today in the server's own calendar day", () => {
    expect(today(new Date(2026, 9, 16, 23, 30))).toBe("2026-10-16");
    expect(today(new Date(2026, 9, 17, 0, 30))).toBe("2026-10-17");
  });
});
