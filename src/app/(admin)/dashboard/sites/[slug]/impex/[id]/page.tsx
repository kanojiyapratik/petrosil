import Link from "@/lib/ui/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { impexForEdit } from "@/domain/impex/editor";
import { ImpexForm } from "../form";
import { deleteImpexAction } from "../actions";
import { ConfirmDelete } from "@/app/(admin)/content-tools";
import { authorsFor } from "@/domain/content/articles";
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

  const search = await searchParams;
  const refused = one(search, "refused");

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/impex`}>
        ← Impex sheets
      </Link>

      <Heading title={sheet.title} sub={`${sheet.site_name} · last edited ${when(sheet.updated_at)}`}>
        {sheet.status !== "draft" ? (
          <a className="button small ghost" href={`/${slug}/impex/${encodeURIComponent(sheet.slug)}`} target="_blank" rel="noreferrer">
            View on site ↗
          </a>
        ) : null}
      </Heading>

      {refused ? (
        <p className="flash bad" role="alert">
          {refused}
        </p>
      ) : null}

      {one(search, "saved") === "1" ? (
        <p className="flash" role="status">
          Sheet created.
        </p>
      ) : null}

      <ImpexForm slug={slug} sheet={sheet} authors={await authorsFor(sheet.author_id)} />

      <ConfirmDelete action={deleteImpexAction} id={sheet.id} site={slug} noun="impex sheet" list="Impex sheets" />
    </>
  );
}
