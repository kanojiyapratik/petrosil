/**
 * The rows of a staff-alert email, as the "Admin Email" template's `{content}`
 * slot expects them: a two-column table, every value escaped, empty rows left
 * out. Shared by enquiries and the account and subscription alerts so every
 * alert staff receive looks the same.
 */

function escape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function detailsTable(rows: [string, unknown][]): string {
  return rows
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
    .map(
      ([label, value]) =>
        `<tr><td style="width:30%;padding:8px;border-bottom:1px solid #ddd">${escape(label)}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #ddd">${escape(value).replace(/\n/g, "<br />")}</td></tr>`,
    )
    .join("");
}
