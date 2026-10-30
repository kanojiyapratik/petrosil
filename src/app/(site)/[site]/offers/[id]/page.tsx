/** One offer, counted as one view, with a reply box for readers the brand lets reply. */

import Link from "next/link";
import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { publishedOffer } from "@/domain/public/offers";
import { liveBrandBySlug, readerFor } from "@/lib/public/reader";
import { cleanHtml, plainText } from "@/lib/public/html";
import { MessageBox } from "../../contact";
import { Gate, day } from "../../ui";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ site: string; id: string }> };

// Once per request: opening an offer counts a view, and the metadata needs it too.
const load = cache(async (site: string, id: string) => {
  const brand = await liveBrandBySlug(site);
  const number = Number(id);

  if (!brand || !Number.isInteger(number) || number < 1) {
    return null;
  }

  const reader = await readerFor(brand.id);
  const offer = await publishedOffer(brand.id, number, reader.entitlement);

  return offer ? { reader, offer } : null;
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site, id } = await params;
  const found = await load(site, id);

  return found ? { title: found.offer.subject, description: plainText(found.offer.description, 160) || undefined } : {};
}

export default async function Offer({ params }: Props) {
  const { site, id } = await params;
  const found = await load(site, id);

  if (!found) {
    notFound();
  }

  const { offer, reader } = found;
  const rows: [string, React.ReactNode][] = [
    ["Company", offer.company_name],
    ["Where", [offer.city, offer.state, offer.country].filter(Boolean).join(", ") || null],
    ["Value", offer.offer_value],
    ["Contact", offer.contact_person],
    ["Email", offer.contact_email ? <a href={`mailto:${offer.contact_email}`}>{offer.contact_email}</a> : null],
    ["Phone", offer.contact_phone],
  ];
  const shown = rows.filter(([, value]) => value);

  return (
    <article className="bs-card">
      <Link className="bs-crumb" href={`/${site}/offers`}>
        ← Offers
      </Link>
      <div className="bs-byline" style={{ marginTop: 0 }}>
        <span className={`bs-kind ${offer.offer_type}`}>{offer.offer_type === "buy" ? "Wanted" : "For sale"}</span>
        <time dateTime={offer.posted_on}>Posted {day(offer.posted_on)}</time>
      </div>
      <h1 style={{ fontSize: "clamp(24px, 3.4vw, 32px)", maxWidth: "30ch", marginBottom: 16 }}>{offer.subject}</h1>

      {offer.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="bs-offer-img" src={offer.image_url} alt="" />
      ) : null}

      {offer.description ? <div className="bs-prose" dangerouslySetInnerHTML={{ __html: cleanHtml(offer.description) }} /> : null}

      {shown.length > 0 ? (
        <dl className="bs-facts">
          {shown.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <Gate site={site} entitlement={reader.entitlement} lead="The full details, the price and replying to the poster are for subscribers." />

      {offer.can_contact && reader.viewer.userId !== null ? (
        <MessageBox
          site={site}
          kind="offer"
          to={offer.id}
          allowed
          signedIn
          back={`/${site}/offers/${offer.id}`}
          title="Reply to this offer"
          subject={`Re: ${offer.subject}`.slice(0, 255)}
        />
      ) : null}
    </article>
  );
}
