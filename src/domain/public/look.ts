/**
 * How a brand looks on its site: its colour and its one-line description.
 *
 * `sites.theme` holds them once staff set them; until then each brand wears
 * the colour and line the platform demo gave it, so a brand is never shown
 * in another brand's colours, nor in none.
 */

export type BrandLook = { color: string; tagline: string };

const DEFAULTS: Record<string, BrandLook> = {
  baseoil: { color: "#0b6b8a", tagline: "Base oils & lubricants pricing" },
  bitumart: { color: "#8a4512", tagline: "Bitumen markets & Indian refinery prices" },
  waxreport: { color: "#6f6413", tagline: "Paraffin & specialty waxes" },
  titaniumdioxidereport: { color: "#44678f", tagline: "TiO₂ pigment markets" },
  chemicalexplorer: { color: "#0f7d57", tagline: "Specialty chemicals" },
  petrosilicon: { color: "#6d4fa1", tagline: "Silicones & intermediates" },
  fertilizerreport: { color: "#4e7d1a", tagline: "Fertilizer markets" },
  methanolreport: { color: "#2563a8", tagline: "Methanol markets" },
  glycerinereport: { color: "#a3486d", tagline: "Glycerine markets" },
};

const FALLBACK: BrandLook = { color: "#0b6b8a", tagline: "Market intelligence" };

/** A colour safe to put in a style attribute: #rgb or #rrggbb, nothing else. */
const isColour = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value);

export function brandLook(site: { slug: string; theme: Record<string, string> | null }): BrandLook {
  const base = DEFAULTS[site.slug] ?? FALLBACK;
  const theme = site.theme ?? {};

  return {
    color: isColour(theme.color) ? theme.color : base.color,
    tagline: typeof theme.tagline === "string" && theme.tagline.trim() ? theme.tagline.trim() : base.tagline,
  };
}
