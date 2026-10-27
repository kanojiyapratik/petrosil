import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { templateForEdit } from "@/domain/content/newsletter-templates";
import { DeleteTemplate, TemplateForm } from "../form";
import { Heading, one, when, type Search } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

export default async function TemplatePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug, id } = await params;
  const template = await templateForEdit(viewer.siteIds, Number(id));

  // Another brand's template, reached through this brand's address, is not found here.
  if (!template || template.site !== slug) {
    notFound();
  }

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/templates`}>
        ← Templates
      </Link>

      <Heading
        title={template.title}
        sub={`${template.site_name} · ${template.used_by} issue${template.used_by === 1 ? "" : "s"} composed from it · last edited ${when(template.updated_at)}`}
      >
        <span className={`badge ${template.enabled ? "ok" : ""}`}>{template.enabled ? "offered" : "switched off"}</span>
      </Heading>

      {one(await searchParams, "saved") === "1" ? (
        <p className="flash" role="status">
          Template created.
        </p>
      ) : null}

      {template.unfilled.length > 0 ? (
        <p className="note">
          Composing an issue leaves {template.unfilled.map((name) => `{${name}}`).join(", ")} empty.
        </p>
      ) : null}

      <TemplateForm slug={slug} template={template} />

      <DeleteTemplate slug={slug} id={template.id} usedBy={template.used_by} />
    </>
  );
}
