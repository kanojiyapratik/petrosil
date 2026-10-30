/** A member's own offers on this brand, with how often each was opened, and a way to take one down. */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";

import { myOffers } from "@/domain/offers/member";
import { currentIdentity } from "@/lib/auth/server";
import { liveBrandBySlug } from "@/lib/public/reader";
import { withdrawBrandOffer } from "../../actions";
import { day } from "../../ui";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "My offers" };

const STATUS: Record<string, string> = {
  published: "Live",
  draft: "Not live",
  suspended: "Taken down by our team",
};

export default async function MyOffers({
  params,
  searchParams,
}: {
  params: Promise<{ site: string }>;
  searchParams: Promise<{ posted?: string }>;
}) {
  const { site } = await params;
  const brand = await liveBrandBySlug(site);

  if (!brand) {
    notFound();
  }

  const identity = await currentIdentity();

  if (!identity) {
    redirect(`/${site}/sign-in?next=${encodeURIComponent(`/${site}/offers/mine`)}`);
  }

  const { posted } = await searchParams;
  const offers = await myOffers(identity.user.id, brand.id);

  return (
    <section>
      <Link className="bs-crumb" href={`/${site}/offers`}>
        ← Offers
      </Link>
      <div className="bs-head">
        <h1>My offers</h1>
        <span className="more">
          <Link className="btn" href={`/${site}/offers/new`}>
            Post an offer
          </Link>
        </span>
      </div>

      {posted ? <p className="bs-flash good">Your offer is live.</p> : null}

      {offers.length > 0 ? (
        <div className="bs-card">
          <div className="bs-scroll">
            <table>
              <thead>
                <tr>
                  <th>Offer</th>
                  <th>Posted</th>
                  <th className="r">Opened</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {offers.map((offer) => (
                  <tr key={offer.id}>
                    <td>
                      <span className={`bs-kind ${offer.offer_type}`}>{offer.offer_type === "buy" ? "Wanted" : "For sale"}</span>{" "}
                      {offer.status === "published" ? <Link href={`/${site}/offers/${offer.id}`}>{offer.subject}</Link> : offer.subject}
                    </td>
                    <td className="num nowrap">{day(offer.posted_on)}</td>
                    <td className="r num">{offer.clicks.toLocaleString("en-US")}</td>
                    <td>{STATUS[offer.status] ?? offer.status}</td>
                    <td className="r">
                      <form action={withdrawBrandOffer}>
                        <input type="hidden" name="site" value={site} />
                        <input type="hidden" name="id" value={offer.id} />
                        <button className="btn ghost small" type="submit">
                          Take down
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="bs-empty">You have not posted any offers on {brand.name} yet.</div>
      )}
    </section>
  );
}
