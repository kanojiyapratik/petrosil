import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listCategories } from "@/domain/dashboard/catalogue";
import { articleForEdit } from "@/domain/content/articles";
import { ArticleForm, WithdrawArticle } from "../form";
import { Heading, one, when, type Search } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

export default async function ArticlePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug, id } = await params;
  const refused = one(await searchParams, "refused");

  const article = await articleForEdit(viewer.siteIds, Number(id));

  if (!article) {
    notFound();
  }

  const [brands, categories] = await Promise.all([
    brandsFor(viewer.siteIds),
    listCategories(viewer.siteIds, { site: article.site }),
  ]);

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/articles`}>
        ← Articles
      </Link>

      <Heading
        title={article.title}
        sub={`${article.site_name} · last edited ${when(article.updated_at)}`}
      >
        <span className={`badge ${article.status === "published" ? "ok" : "warn"}`}>
          {article.status}
        </span>
        {article.premium_only ? <span className="badge brand">subscribers only</span> : null}
      </Heading>

      {refused ? (
        <p className="flash bad" role="alert">
          {refused}
        </p>
      ) : null}

      <ArticleForm slug={slug} brands={brands} categories={categories} article={article} />

      <WithdrawArticle id={article.id} />
    </>
  );
}
