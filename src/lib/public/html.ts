/**
 * Stored HTML made safe to put on a brand page.
 *
 * Articles, pages and reports carry HTML — 92,732 articles came from the old
 * sites, written in three editors over ten years, and staff keep writing it.
 * The old pages printed it raw. Here it keeps its formatting, links, images
 * and tables, and loses anything that runs: scripts, event handlers,
 * `javascript:` links, frames, forms and inline styles.
 */

import sanitizeHtml from "sanitize-html";

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    "img",
    "figure",
    "figcaption",
    "h1",
    "h2",
    "sup",
    "sub",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan", "scope"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
  // A link that opens a new tab cannot reach back into the brand page.
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: attribs.target === "_blank" ? { ...attribs, rel: "noopener noreferrer" } : attribs,
    }),
  },
};

export function cleanHtml(html: string | null | undefined): string {
  return html ? sanitizeHtml(html, OPTIONS) : "";
}

/** Plain text, for a card or a meta description. */
export function plainText(html: string | null | undefined, max = 220): string {
  const text = sanitizeHtml(html ?? "", { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
