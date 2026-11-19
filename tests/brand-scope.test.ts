/**
 * The header's brand filter: what a choice narrows list queries to.
 *
 * The case that matters is the one that could widen: a slug the viewer was
 * never granted (or lost) must fall back to what they may see, never to the
 * brand it names.
 */
import { describe, expect, test } from "vitest";

import { narrowTo } from "@/app/(admin)/brand-scope";

const baseoil = { id: 1, slug: "baseoil", name: "Base Oil Report" };
const bitumart = { id: 2, slug: "bitumart", name: "Bitumart" };

describe("narrowTo", () => {
  test("no choice reads everything the viewer may see", () => {
    expect(narrowTo([], [baseoil, bitumart], undefined)).toEqual({
      brand: null,
      brands: [baseoil, bitumart],
      siteIds: [],
    });
    expect(narrowTo([1, 2], [baseoil, bitumart], undefined).siteIds).toEqual([1, 2]);
  });

  test("a chosen brand narrows to that brand alone, superadmin included", () => {
    const scope = narrowTo([], [baseoil, bitumart], "bitumart");

    expect(scope.brand).toEqual(bitumart);
    expect(scope.siteIds).toEqual([2]);
  });

  test("a brand the viewer cannot see counts as no choice, not as that brand", () => {
    // Staff holding baseoil only: brandsFor gave them baseoil alone.
    const scope = narrowTo([1], [baseoil], "bitumart");

    expect(scope.brand).toBeNull();
    expect(scope.siteIds).toEqual([1]);
  });

  test("a brand that no longer exists counts as no choice", () => {
    expect(narrowTo([], [baseoil, bitumart], "gone").siteIds).toEqual([]);
  });
});
