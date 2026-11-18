/**
 * {WEBSITELINK} in the old newsletter templates: upper case, so the placeholder
 * fill never touched it and the logo and links went out pointing nowhere.
 */
import { describe, expect, it } from "vitest";

import { fillSiteLink } from "@/domain/content/newsletters";
import { linkBaseFor } from "@/lib/mail/deliver";

const site = { slug: "chemicalexplorer", domain: "www.chemicalexplorer.com" };
const pages = linkBaseFor(site);

describe("fillSiteLink", () => {
  it("points links at the brand's pages here, and /contact at /contact-us", () => {
    const body =
      '<a href="{WEBSITELINK}/">Home</a><a href="{WEBSITELINK}/reports">R</a><a href="{WEBSITELINK}/contact">C</a><a href="{WEBSITELINK}">x</a>';

    expect(fillSiteLink(body, site)).toBe(
      `<a href="${pages}/">Home</a><a href="${pages}/reports">R</a><a href="${pages}/contact-us">C</a><a href="${pages}">x</a>`,
    );
  });

  it("keeps pictures on the brand's old website, where the files are", () => {
    const body = '<img src="{WEBSITELINK}/img/Logo.jpg" /><img src="{websitelink}/mailer/nl/icon1.png">';

    expect(fillSiteLink(body, site)).toBe(
      '<img src="https://www.chemicalexplorer.com/img/Logo.jpg" /><img src="https://www.chemicalexplorer.com/mailer/nl/icon1.png">',
    );
  });

  it("leaves a body without the placeholder exactly as it is", () => {
    const body = "<p>{articles} and {offers}</p>";

    expect(fillSiteLink(body, site)).toBe(body);
  });

  it("falls back to the brand's pages here for pictures when it has no old domain", () => {
    expect(fillSiteLink('<img src="{WEBSITELINK}/img/a.png">', { slug: "baseoil", domain: null })).toBe(
      `<img src="${linkBaseFor({ slug: "baseoil", domain: null })}/img/a.png">`,
    );
  });
});
