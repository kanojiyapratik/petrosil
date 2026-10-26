/**
 * The folders a brand's files live in — the old sites' `file_manager` layout,
 * kept so carried content rows find their files by name — and which of them
 * the public may read.
 */

/** Anyone may load these: they are pictures on public pages. */
export const PUBLIC_FOLDERS = [
  "ads/images",
  "ads/video",
  "articles/images",
  "articles/thumbnail",
  "offers/images",
  "pages/images",
  "reports/images",
  "reports/thumbnail",
  "subscriptions/images",
  "subscriptions/thumbnail",
] as const;

/** Paid or private: report PDFs, trade sheets, attachments. Staff only, until a paywalled download. */
export const PRIVATE_FOLDERS = [
  "articles/files",
  "impex/files",
  "offers/files",
  "reports/files",
  "subscriptions/files",
] as const;

export const FOLDERS: readonly string[] = [...PUBLIC_FOLDERS, ...PRIVATE_FOLDERS].sort();

export const isPublicFolder = (folder: string) => (PUBLIC_FOLDERS as readonly string[]).includes(folder);

/** Which folder each content column's bare file name points into. */
export const REFERENCES = [
  { table: "articles", column: "hero_image", folder: "articles/thumbnail" },
  { table: "reports", column: "file", folder: "reports/files" },
  { table: "reports", column: "thumbnail", folder: "reports/thumbnail" },
  { table: "offers", column: "image", folder: "offers/images" },
  { table: "offers", column: "file", folder: "offers/files" },
  { table: "impex_sheets", column: "file", folder: "impex/files" },
  { table: "ads", column: "image", folder: "ads/images" },
  { table: "ads", column: "video", folder: "ads/video" },
] as const;

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");

  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** A content type from the name, or null for one this platform does not serve. */
export function typeFor(name: string): string | null {
  return TYPES[extensionOf(name)] ?? null;
}

/** Operating-system and editor leftovers that were never content. */
export function isLitter(name: string): boolean {
  const lower = name.toLowerCase();

  return lower.startsWith(".") || lower.startsWith("~$") || lower === "thumbs.db" || lower === "desktop.ini";
}
