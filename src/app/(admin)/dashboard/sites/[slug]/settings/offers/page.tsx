import { FieldsScreen } from "../fields";
import { one, type Search } from "@/app/(admin)/ui";

export const metadata = { title: "Offer fields · Petrosil" };
export const dynamic = "force-dynamic";

export default async function OfferFieldsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const { slug } = await params;
  const search = await searchParams;

  return (
    <FieldsScreen
      form="offer"
      site={one(search, "site")}
      base={`/dashboard/sites/${slug}/settings/offers`}
      title="Offer fields"
      sub="Which parts of a buy or sell offer each kind of reader sees."
    />
  );
}
