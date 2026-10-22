import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listCategories } from "@/domain/dashboard/catalogue";
import { ArticleForm } from "../form";
import { Heading } from "../../../ui";

export const metadata = { title: "New article · Petrosil" };
export const dynamic = "force-dynamic";

export default async function NewArticlePage() {
  const viewer = (await currentViewer())!;

  const [brands, categories] = await Promise.all([
    brandsFor(viewer.siteIds),
    listCategories(viewer.siteIds),
  ]);

  return (
    <>
      <Link className="crumb" href="/dashboard/articles">
        ← Articles
      </Link>

      <Heading title="New article" sub="Saved as a draft. Nothing reaches a brand site until you publish it." />

      <ArticleForm brands={brands} categories={categories} />
    </>
  );
}
