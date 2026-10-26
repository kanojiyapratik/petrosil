/**
 * Settings, with a catalogue.
 *
 * The old sites kept 69 rows of `name`/`val` per site and nothing said what
 * a name meant, what shape its value was, or whether anything read it. Nine
 * copies of that is 621 rows, and among them — in plain text, in a table any
 * admin could list — sat a SendGrid password, a TinyMCE key, a GetResponse
 * API key and a MailWizz token.
 *
 * So two changes. The keys are a code catalogue, which is what makes an
 * unrecognised row visible as junk rather than as configuration. And a key
 * marked secret is never handed to a screen in full: the screen is told that
 * a value is set and shown its last four characters, which is enough to tell
 * two keys apart and not enough to use one.
 *
 * A row with no `siteId` is the estate's default; a row with one overrides
 * it for that brand. That is how one support address can be shared by eight
 * brands and different on the ninth, which is the actual arrangement.
 */

import { and, eq, inArray, isNull, or } from "drizzle-orm";

import { db, type Database } from "@/db";
import { settings, sites } from "@/db/schema";

export type SettingKind = "text" | "textarea" | "email" | "number" | "secret";

export type SettingDef = {
  key: string;
  label: string;
  group: string;
  kind: SettingKind;
  help?: string;
};

export const SETTINGS: SettingDef[] = [
  // --- how a brand describes itself
  { key: "site_title", label: "Site title", group: "Brand", kind: "text" },
  { key: "site_description", label: "Description", group: "Brand", kind: "textarea" },
  { key: "site_keywords", label: "Keywords", group: "Brand", kind: "text" },
  {
    key: "site_admin_email",
    label: "Admin address",
    group: "Brand",
    kind: "email",
    help: "Where the site writes to when something needs a person.",
  },
  { key: "site_support_email", label: "Support address", group: "Brand", kind: "email" },

  // --- how mail leaves
  {
    key: "mail_transport",
    label: "Send mail by",
    group: "Mail",
    kind: "text",
    help: "smtp, or the name of a provider.",
  },
  { key: "mail_from_address", label: "From address", group: "Mail", kind: "email" },
  { key: "mail_reply_to", label: "Reply-to address", group: "Mail", kind: "email" },
  { key: "smtp_host", label: "SMTP host", group: "Mail", kind: "text" },
  { key: "smtp_port", label: "SMTP port", group: "Mail", kind: "number" },
  { key: "smtp_username", label: "SMTP username", group: "Mail", kind: "text" },
  { key: "smtp_password", label: "SMTP password", group: "Mail", kind: "secret" },

  // --- who gets told
  {
    key: "report_recipients",
    label: "Report goes to",
    group: "Notifications",
    kind: "textarea",
    help: "One address per line. These people are copied on every published report.",
  },
  {
    key: "offer_recipients",
    label: "Offer alerts go to",
    group: "Notifications",
    kind: "textarea",
    help: "One address per line.",
  },

  // --- third parties
  { key: "tinymce_key", label: "TinyMCE key", group: "Integrations", kind: "secret" },
  { key: "getresponse_key", label: "GetResponse key", group: "Integrations", kind: "secret" },
  { key: "getresponse_list", label: "GetResponse list", group: "Integrations", kind: "text" },
  { key: "mailwizz_list", label: "MailWizz list", group: "Integrations", kind: "text" },
  { key: "razorpay_key_id", label: "Razorpay key id", group: "Integrations", kind: "text" },

  // --- how the sites behave
  {
    key: "items_per_page",
    label: "Rows per page",
    group: "Behaviour",
    kind: "number",
    help: "On the brand sites' own listings.",
  },
  {
    key: "trial_days",
    label: "Trial length",
    group: "Behaviour",
    kind: "number",
    help: "Days granted when a free trial is approved.",
  },
];

export type SettingRow = SettingDef & {
  /** The value in force. A secret is masked. */
  value: string;
  /** Whether anything is saved at all — the honest answer for a secret. */
  set: boolean;
  secret: boolean;
  source: "brand" | "estate" | "unset";
};

/** The last four characters, enough to tell two keys apart. */
function mask(value: string): string {
  if (value.length <= 4) {
    return "••••";
  }

  return `${"•".repeat(8)}${value.slice(-4)}`;
}

/**
 * Every setting in the catalogue, with the value in force for one brand.
 *
 * With no brand asked for it reports the estate's defaults. Keys saved in
 * the database that the catalogue does not know about are reported by
 * `strandedSettings` instead, so they are visible without being presented as
 * though something reads them.
 */
export async function settingsFor(
  siteIds: number[],
  query: { site?: string } = {},
  database: Database = db(),
): Promise<SettingRow[]> {
  const brand = query.site
    ? (await database.select().from(sites).where(eq(sites.slug, query.site)).limit(1))[0]
    : undefined;

  const allowed = !brand || siteIds.length === 0 || siteIds.includes(brand.id);

  const rows = await database
    .select()
    .from(settings)
    .where(
      brand && allowed
        ? or(isNull(settings.siteId), eq(settings.siteId, brand.id))
        : isNull(settings.siteId),
    );

  const estate = new Map<string, string>();
  const perBrand = new Map<string, string>();

  for (const row of rows) {
    if (row.siteId === null) {
      estate.set(row.key, row.value);
    } else {
      perBrand.set(row.key, row.value);
    }
  }

  return SETTINGS.map((def) => {
    const own = perBrand.get(def.key);
    const shared = estate.get(def.key);
    const raw = own ?? shared ?? "";
    const secret = def.kind === "secret";

    return {
      ...def,
      secret,
      set: raw !== "",
      value: secret && raw !== "" ? mask(raw) : raw,
      source: own !== undefined ? "brand" : shared !== undefined ? "estate" : "unset",
    };
  });
}

/** Saved keys the catalogue does not know — carried over and read by nothing. */
export async function strandedSettings(
  siteIds: number[],
  database: Database = db(),
): Promise<{ key: string; site: string | null; sample: string }[]> {
  const known = new Set(SETTINGS.map((def) => def.key));

  const rows = await database
    .select({ setting: settings, slug: sites.slug })
    .from(settings)
    .leftJoin(sites, eq(sites.id, settings.siteId))
    .where(
      siteIds.length > 0
        ? or(isNull(settings.siteId), inArray(settings.siteId, siteIds))
        : undefined,
    );

  return rows
    .filter(({ setting }) => !known.has(setting.key))
    .map(({ setting, slug }) => ({
      key: setting.key,
      site: slug,
      sample: setting.value.length > 40 ? `${setting.value.slice(0, 40)}…` : setting.value,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Save one setting, for a brand or for the estate.
 *
 * A blank value deletes the row rather than storing an empty string, so
 * clearing a brand's override falls back to the estate's default instead of
 * overriding it with nothing.
 */
export async function saveSetting(
  siteId: number | null,
  key: string,
  value: string,
  database: Database = db(),
): Promise<{ ok: boolean }> {
  if (!SETTINGS.some((def) => def.key === key)) {
    return { ok: false };
  }

  const where = and(
    eq(settings.key, key),
    siteId === null ? isNull(settings.siteId) : eq(settings.siteId, siteId),
  );

  if (value.trim() === "") {
    await database.delete(settings).where(where);

    return { ok: true };
  }

  const [existing] = await database.select().from(settings).where(where).limit(1);

  if (existing) {
    await database
      .update(settings)
      .set({ value, updatedAt: new Date() })
      .where(eq(settings.id, existing.id));
  } else {
    await database.insert(settings).values({ siteId, key, value });
  }

  return { ok: true };
}

/**
 * One setting as a brand sees it: the brand's own value, else the estate's,
 * else null. For code that acts on a setting rather than a screen that shows
 * the whole catalogue.
 */
export async function brandSetting(
  siteId: number,
  key: string,
  database: Database = db(),
): Promise<string | null> {
  const rows = await database
    .select({ siteId: settings.siteId, value: settings.value })
    .from(settings)
    .where(and(eq(settings.key, key), or(isNull(settings.siteId), eq(settings.siteId, siteId))));

  const value = (rows.find((row) => row.siteId === siteId) ?? rows.find((row) => row.siteId === null))?.value;

  return value?.trim() ? value.trim() : null;
}
