import Link from "@/lib/ui/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { offerForEdit } from "@/domain/offers/editor";
import { OfferForm } from "../form";
import { deleteOfferAction } from "../actions";
import { ConfirmDelete } from "@/app/(admin)/content-tools";
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

  const search = await searchParams;
  const justMade = one(search, "saved") === "1";
  const refused = one(search, "refused");

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/offers`}>
        ← Offers
      </Link>

      <Heading
        title={offer.subject}
        sub={`${offer.site_name} · posted ${when(offer.created_at)}${offer.poster_name ? ` for ${offer.poster_name}` : ""} · last edited ${when(offer.updated_at)}`}
      >
        {offer.status !== "draft" ? (
          <a className="button small ghost" href={`/${slug}/offers/${offer.id}`} target="_blank" rel="noreferrer">
            View on site ↗
          </a>
        ) : null}
      </Heading>

      {refused ? (
        <p className="flash bad" role="alert">
          {refused}
        </p>
      ) : null}

      {justMade ? (
        <p className="flash" role="status">
          Offer created.
        </p>
      ) : null}

      <OfferForm slug={slug} offer={offer} />

      <ConfirmDelete action={deleteOfferAction} id={offer.id} site={slug} noun="offer" list="Offers" />
    </>
  );
}
