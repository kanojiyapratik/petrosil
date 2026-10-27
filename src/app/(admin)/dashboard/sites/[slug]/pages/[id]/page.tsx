import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { pageForEdit } from "@/domain/content/pages";
import { DeletePage, PageForm } from "../form";
import { Heading, one, when, type Search } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

export default async function EditPagePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug, id } = await params;
  const page = await pageForEdit(viewer.siteIds, Number(id));

  // Another brand's page, reached through this brand's address, is not found here.
  if (!page || page.site !== slug) {
    notFound();
  }

  const justMade = one(await searchParams, "saved") === "1";

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/pages`}>
        ← Pages
      </Link>

      <Heading title={page.title} sub={`${page.site_name} · /${page.slug} · last edited ${when(page.updated_at)}`}>
        <span className={`badge ${page.visible ? "ok" : ""}`}>{page.visible ? "shown" : "hidden"}</span>
      </Heading>

      {justMade ? (
        <p className="flash" role="status">
          Page created.
        </p>
      ) : null}

      <PageForm slug={slug} page={page} />

      <DeletePage slug={slug} id={page.id} />
    </>
  );
}
