/** The brand's articles, newest first, by category and by search. */

import Link from "next/link";
import { notFound } from "next/navigation";

import { publishedArticles } from "@/domain/content/articles";
import { liveCategories } from "@/domain/content/categories";
import { liveBrandBySlug } from "@/lib/public/reader";
import { plainText } from "@/lib/public/html";
import { Pager, day, pageParam } from "../ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Articles" };

const PER_PAGE = 24;

export default async function Articles({
  params,
  searchParams,
}: {
  params: Promise<{ site: string }>;
  searchParams: Promise<{ q?: string; category?: string; page?: string }>;
}) {
  const { site } = await params;
  const brand = await liveBrandBySlug(site);

  if (!brand) {
    notFound();
  }

  const query = await searchParams;
  const q = String(query.q ?? "").trim().slice(0, 80);
  const category = String(query.category ?? "").trim().slice(0, 191);
  const page = pageParam(query.page);

  const [found, categories] = await Promise.all([
    publishedArticles(brand.id, {
      search: q || undefined,
      category: category || undefined,
      limit: PER_PAGE,
      offset: (page - 1) * PER_PAGE,
    }),
    liveCategories(brand.id),
  ]);

  const pages = Math.ceil(found.total / PER_PAGE);
  const kept = { ...(q ? { q } : {}), ...(category ? { category } : {}) };

  return (
    <section>
      <div className="bs-head">
        <h1>Articles</h1>
        <span className="muted num">{found.total.toLocaleString("en-US")} published</span>
      </div>

      <form className="bs-search" role="search">
        {category ? <input type="hidden" name="category" value={category} /> : null}
        <input type="search" name="q" defaultValue={q} placeholder="Search article titles…" aria-label="Search articles" />
        <button className="btn" type="submit">
          Search
        </button>
      </form>

      {categories.length > 1 ? (
        <nav className="bs-chips" aria-label="Categories">
          <Link href={`/${site}/articles${q ? `?q=${encodeURIComponent(q)}` : ""}`} aria-current={category ? undefined : "true"}>
            All
          </Link>
          {categories.map((c) => (
            <Link
              key={c.slug}
              href={`/${site}/articles?${new URLSearchParams({ ...(q ? { q } : {}), category: c.slug })}`}
              aria-current={c.slug === category ? "true" : undefined}
            >
              {c.name}
            </Link>
          ))}
        </nav>
      ) : null}

      {found.articles.length > 0 ? (
        <div className="bs-cards">
          {found.articles.map((article) => (
            <Link key={article.id} className="bs-art" href={`/${site}/articles/${article.slug}`}>
              {article.category ? <div className="cat">{article.category.replace(/-/g, " ")}</div> : null}
              <h3>
                {article.title}
                {article.premium_only ? <span className="bs-tag">Subscribers</span> : null}
              </h3>
              {article.excerpt ? <p>{plainText(article.excerpt, 160)}</p> : null}
              <time dateTime={article.published_at ?? undefined}>{day(article.published_at)}</time>
            </Link>
          ))}
        </div>
      ) : (
        <div className="bs-empty">{q ? `No article title matches “${q}”.` : "No articles here yet."}</div>
      )}

      <Pager base={`/${site}/articles`} page={page} pages={pages} query={kept} />
    </section>
  );
}
