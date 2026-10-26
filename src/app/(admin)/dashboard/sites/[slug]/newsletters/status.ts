/** How each newsletter status is shown. "archived" is an issue carried from an old site. */
export const STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: "draft", tone: "warn" },
  scheduled: { label: "scheduled", tone: "warn" },
  sent: { label: "sent", tone: "ok" },
  archived: { label: "old site", tone: "" },
};
