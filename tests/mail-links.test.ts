/**
 * Where the links in a brand's mail point: its pages in this app, unless
 * MAIL_LINK_BASE says otherwise.
 */

import { describe, expect, it } from "vitest";

import { linkBaseFor } from "@/lib/mail/deliver";
import { renderMail } from "@/lib/mail/render";

const BASEOIL = { slug: "baseoil", domain: "baseoilreport.com" };

describe("a brand's mail links", () => {
  it("go to the brand's pages in this app", () => {
    expect(linkBaseFor(BASEOIL, { PUBLIC_APP_URL: "https://app.petrosil.com/" })).toBe("https://app.petrosil.com/baseoil");
  });

  it("fall back to the local app when no address is set", () => {
    expect(linkBaseFor(BASEOIL, {})).toBe("http://localhost:3100/baseoil");
  });

  it("can be sent to the old domain, or anywhere else, by MAIL_LINK_BASE", () => {
    expect(linkBaseFor(BASEOIL, { MAIL_LINK_BASE: "https://{domain}" })).toBe("https://baseoilreport.com");
    expect(linkBaseFor(BASEOIL, { MAIL_LINK_BASE: "https://cdn.example/{slug}/" })).toBe("https://cdn.example/baseoil");
  });

  it("go to the app itself for mail that belongs to no brand", () => {
    expect(linkBaseFor({ slug: null, domain: null }, { PUBLIC_APP_URL: "https://app.petrosil.com" })).toBe("https://app.petrosil.com");
  });

  it("reach pages that exist: confirming lands on the brand's confirm page, signing in on its sign-in page", () => {
    const linkBase = linkBaseFor(BASEOIL, { PUBLIC_APP_URL: "https://app.petrosil.com" });
    const mail = (template: string, payload: Record<string, unknown>) =>
      renderMail({ id: 1, to: "reader@example.test", subject: "s", template, payload } as never, { linkBase, stored: null });

    expect(mail("verify_email", { token: "abc" }).text).toContain("https://app.petrosil.com/baseoil/verify-email?token=abc");
    expect(mail("reset_password", { token: "xyz" }).text).toContain("https://app.petrosil.com/baseoil/reset-password?token=xyz");
    expect(mail("account_exists", { siteName: "Base Oil Report" }).text).toContain("https://app.petrosil.com/baseoil/sign-in");
  });
});
