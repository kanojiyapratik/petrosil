import { FieldsScreen } from "../fields";
import { one, type Search } from "../../../ui";

export const metadata = { title: "Offer fields · Petrosil" };
export const dynamic = "force-dynamic";

export default async function OfferFieldsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const search = await searchParams;

  return (
    <FieldsScreen
      form="offer"
      site={one(search, "site")}
      base="/dashboard/settings/offers"
      title="Offer fields"
      sub="Which parts of a buy or sell offer each kind of reader sees."
    />
  );
}
