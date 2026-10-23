import { FieldsScreen } from "../fields";
import { one, type Search } from "../../../ui";

export const metadata = { title: "Directory fields · Petrosil" };
export const dynamic = "force-dynamic";

export default async function DirectoryFieldsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const search = await searchParams;

  return (
    <FieldsScreen
      form="directory"
      site={one(search, "site")}
      base="/dashboard/settings/directory"
      title="Directory fields"
      sub="Which parts of a company's directory entry each kind of reader sees. This is the paywall."
    />
  );
}
