import Link from "@/lib/ui/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { users } from "@/db/schema";
import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listCategories } from "@/domain/dashboard/catalogue";
import { articleAuthors, articleForEdit } from "@/domain/content/articles";
import { editableHtml } from "@/lib/public/html";
import { ArticleForm } from "../form";
import { DeleteArticle } from "../fields";
import { Heading, one, when, type Search } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = { published: "published", draft: "draft", withdrawn: "taken down" };

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

  const [brands, categories, authors] = await Promise.all([
    brandsFor(viewer.siteIds),
    listCategories(viewer.siteIds, { site: article.site }),
    articleAuthors(),
  ]);

  // An author carried from the old sites who is not on today's list is still
  // shown, so saving the piece does not quietly drop them.
  if (article.author_id !== null && !authors.some((author) => author.id === article.author_id)) {
    const [carried] = await db()
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, article.author_id))
      .limit(1);

    if (carried) {
      authors.push(carried);
    }
  }

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/articles`}>
        ← Articles
      </Link>

      <Heading title={article.title} sub={`${article.site_name} · last edited ${when(article.updated_at)}`}>
        <span className={`badge ${article.status === "published" ? "ok" : article.status === "withdrawn" ? "" : "warn"}`}>
          {STATUS_LABEL[article.status] ?? article.status}
        </span>
        {article.premium_only ? <span className="badge brand">subscribers only</span> : null}
      </Heading>

      {refused ? (
        <p className="flash bad" role="alert">
          {refused}
        </p>
      ) : null}

      <ArticleForm
        slug={slug}
        brands={brands}
        categories={categories}
        authors={authors}
        article={article}
        body={editableHtml(article.body)}
        me={viewer.identity.user.id}
      />

      <DeleteArticle id={article.id} site={article.site} />
    </>
  );
}
