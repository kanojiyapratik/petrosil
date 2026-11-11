/**
 * A brand site's frame: the announcement strip, the masthead in the brand's
 * colour, and a footer listing the brand's own pages.
 *
 * Every brand is a path on one application (`/baseoil`, `/bitumart`, …), as
 * the owner's demo proposed; the section names keep the old sites' URLs
 * (`price-trends`, `ai-market-insights`, `articles/…`) so links people saved
 * still mean something once the old domains redirect here.
 */

import "../site.css";

import Link from "@/lib/ui/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { brandLook } from "@/domain/public/look";
import { liveAnnouncements, pageIndex } from "@/domain/content/pages";
import { liveBrandBySlug, readerFor } from "@/lib/public/reader";
import { BrandNav } from "./nav";

type Props = { children: React.ReactNode; params: Promise<{ site: string }> };

export async function generateMetadata({ params }: { params: Promise<{ site: string }> }): Promise<Metadata> {
  const brand = await liveBrandBySlug((await params).site);

  if (!brand) {
    return {};
  }

  return {
    title: { default: brand.name, template: `%s · ${brand.name}` },
    description: brandLook(brand).tagline,
  };
}

/** The pages the old sites linked from their footer, in the order readers look for them. */
const ABOUT = ["about-us", "methodology", "analytics", "presentations", "advertise", "contact-us"];
const LEGAL = ["terms-and-conditions", "privacy-policy", "refund-cancellation-policy", "pricing-policy"];

/** "Base Oil Report" → "BO": the words that name the brand, not the word "Report". */
function initials(name: string, most: number): string {
  const words = name.split(/\s+/).filter((word) => word && !/^(report|reports)$/i.test(word));

  return (words.length > 0 ? words : [name])
    .slice(0, most)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

function Logo({ site, name, tagline }: { site: string; name: string; tagline: string }) {
  return (
    <Link className="bs-logo" href={`/${site}`}>
      <span className="mark" aria-hidden>
        {initials(name, 2)}
      </span>
      <span className="name">
        <strong>{name}</strong>
        <small>{tagline}</small>
      </span>
    </Link>
  );
}

export default async function BrandLayout({ children, params }: Props) {
  const { site } = await params;
  const brand = await liveBrandBySlug(site);

  if (!brand) {
    notFound();
  }

  const [look, reader, notices, pages] = await Promise.all([
    brandLook(brand),
    readerFor(brand.id),
    liveAnnouncements(brand.id),
    pageIndex(brand.id),
  ]);

  const titled = new Map(pages.map((page) => [page.slug, page.title]));
  const linked = (slugs: string[]) => slugs.filter((slug) => titled.has(slug));

  return (
    <div className="bs" style={{ "--brand": look.color } as React.CSSProperties}>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=Source+Sans+3:wght@400;500;600;700&display=swap"
      />

      {notices.length > 0 ? (
        <div className="bs-note" role="region" aria-label="Announcements">
          {/* One line, however many are running: the old sites ran them as a ticker. */}
          <div className="bs-note-track" data-many={notices.length > 1 || undefined}>
            {[...notices, ...(notices.length > 1 ? notices : [])].map((notice, index) => (
              <span key={`${notice.id}-${index}`} aria-hidden={index >= notices.length || undefined}>
                {notice.link ? <a href={notice.link}>{notice.body}</a> : notice.body}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <header className="bs-mast">
        <div className="wrap bs-mast-in">
          <Logo site={site} name={brand.name} tagline={look.tagline} />
          <BrandNav site={site} />
          <div className="bs-acct">
            {reader.name ? (
              <Link className="bs-me" href={`/${site}/account`} aria-label={`My account (${reader.name})`}>
                <span className="av" aria-hidden>
                  {initials(reader.name, 2)}
                </span>
                <span>{reader.name.split(/\s+/)[0]}</span>
              </Link>
            ) : (
              <>
                <Link href={`/${site}/sign-in`}>Sign in</Link>
                <Link className="bs-cta" href={`/${site}/subscription`}>
                  Subscribe
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="wrap bs-main">{children}</main>

      <footer className="bs-foot">
        <div className="wrap bs-foot-in">
          <div className="brand">
            <Logo site={site} name={brand.name} tagline={look.tagline} />
            <p>
              {look.tagline}. Independent weekly price assessments, market analysis and trade data from the Petrosil
              research desk.
            </p>
            {reader.entitlement.entitled ? null : (
              <Link className="btn" href={`/${site}/subscription`}>
                Subscribe
              </Link>
            )}
          </div>
          <div>
            <h2>Read</h2>
            <ul>
              <li>
                <Link href={`/${site}/price-trends`}>Price trends</Link>
              </li>
              <li>
                <Link href={`/${site}/ai-market-insights`}>AI market insights</Link>
              </li>
              <li>
                <Link href={`/${site}/articles`}>Articles</Link>
              </li>
              <li>
                <Link href={`/${site}/reports`}>Reports</Link>
              </li>
            </ul>
          </div>
          {linked(ABOUT).length > 0 ? (
            <div>
              <h2>About</h2>
              <ul>
                {linked(ABOUT).map((slug) => (
                  <li key={slug}>
                    <Link href={`/${site}/${slug}`}>{titled.get(slug)}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {linked(LEGAL).length > 0 ? (
            <div>
              <h2>Policies</h2>
              <ul>
                {linked(LEGAL).map((slug) => (
                  <li key={slug}>
                    <Link href={`/${site}/${slug}`}>{titled.get(slug)}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="fine">
            © {new Date().getFullYear()} {brand.name}, a Petrosil publication.
          </p>
        </div>
      </footer>
    </div>
  );
}
