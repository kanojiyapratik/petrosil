import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { offerForEdit } from "@/domain/offers/editor";
import { OfferForm, WithdrawOffer } from "../form";
import { Heading, one, when, type Search } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

export default async function OfferPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug, id } = await params;
  const offer = await offerForEdit(viewer.siteIds, Number(id));

  // Another brand's offer, reached through this brand's address, is not found here.
  if (!offer || offer.site !== slug) {
    notFound();
  }

  const justMade = one(await searchParams, "saved") === "1";

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/offers`}>
        ← Offers
      </Link>

      <Heading
        title={offer.subject}
        sub={`${offer.site_name} · posted ${when(offer.created_at)}${offer.poster_name ? ` for ${offer.poster_name}` : ""} · last edited ${when(offer.updated_at)}`}
      />

      {justMade ? (
        <p className="flash" role="status">
          Offer created.
        </p>
      ) : null}

      <OfferForm slug={slug} offer={offer} />

      <WithdrawOffer slug={slug} id={offer.id} />
    </>
  );
}
