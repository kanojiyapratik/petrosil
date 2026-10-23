import { FieldsScreen } from "../fields";
import { one, type Search } from "@/app/(admin)/ui";

export const metadata = { title: "Directory fields · Petrosil" };
export const dynamic = "force-dynamic";

export default async function DirectoryFieldsPage({
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
      form="directory"
      site={one(search, "site")}
      base={`/dashboard/sites/${slug}/settings/directory`}
      title="Directory fields"
      sub="Which parts of a company's directory entry each kind of reader sees. This is the paywall."
    />
  );
}
