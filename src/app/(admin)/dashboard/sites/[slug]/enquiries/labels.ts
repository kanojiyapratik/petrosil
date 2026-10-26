/** How enquiry kinds and statuses are named on screen. */

export const KIND: Record<string, string> = {
  company: "To a company",
  offer: "Offer reply",
  plan: "About a plan",
};

export const STATUS: Record<string, { label: string; tone: string }> = {
  new: { label: "new", tone: "warn" },
  handled: { label: "handled", tone: "ok" },
  archived: { label: "old site", tone: "" },
};
