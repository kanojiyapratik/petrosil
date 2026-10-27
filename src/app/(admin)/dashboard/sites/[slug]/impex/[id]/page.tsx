import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { impexForEdit } from "@/domain/impex/editor";
import { ImpexForm, WithdrawImpex } from "../form";
import { Heading, one, when, type Search } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

export default async function ImpexPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug, id } = await params;
  const sheet = await impexForEdit(viewer.siteIds, Number(id));

  // Another brand's sheet, reached through this brand's address, is not found here.
  if (!sheet || sheet.site !== slug) {
    notFound();
  }

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/impex`}>
        ← Trade data
      </Link>

      <Heading title={sheet.title} sub={`${sheet.site_name} · last edited ${when(sheet.updated_at)}`} />

      {one(await searchParams, "saved") === "1" ? (
        <p className="flash" role="status">
          Sheet created.
        </p>
      ) : null}

      <ImpexForm slug={slug} sheet={sheet} />

      <WithdrawImpex slug={slug} id={sheet.id} />
    </>
  );
}
