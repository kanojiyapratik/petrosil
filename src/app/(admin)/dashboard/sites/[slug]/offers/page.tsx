/**
 * Offers — the buy and sell notices from the trade.
 *
 * 11,094 on bitumart and 2,719 on baseoil. Most were posted by a member,
 * whose account is carried as "by …"; the rest were typed in by staff for
 * somebody who phoned, which is why the contact details live on the row
 * rather than on an account. Which of those details a reader
 * sees depends on whether they pay: Settings → Offer fields is where that is
 * decided.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listOffers } from "@/domain/dashboard/publishing";
import {
  Chips,
  Empty,
  Filters,
  Heading,
  Pager,
  Panel,
  count,
  one,
  pageParam,
  when,
  type Search,
} from "@/app/(admin)/ui";

export const metadata = { title: "Offers · Petrosil" };
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = { published: "ok", draft: "warn", suspended: "bad" };

export default async function OffersPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const search = await searchParams;

  const site = slug;
  const type = one(search, "type");
  const status = one(search, "status");
  const q = one(search, "q");
  const page = pageParam(one(search, "page"));

  const [brands, paged] = await Promise.all([
    brandsFor(viewer.siteIds),
    listOffers(viewer.siteIds, { site, type, status, search: q, page }),
  ]);

  return (
    <>
      <Heading
        title="Offers"
        sub="Buy and sell notices. Which contact details a reader sees is set per brand."
      >
        <Link className="button ghost small" href={`/dashboard/sites/${slug}/settings/offers`}>
          Offer fields
        </Link>
        <Link className="button small" href={`/dashboard/sites/${slug}/offers/new`}>
          New offer
        </Link>
      </Heading>

      <Panel flush={false}>
        <Filters action={`/dashboard/sites/${slug}/offers`}>
          <div className="field grow">
            <label htmlFor="q">Search</label>
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={q ?? ""}
              placeholder="Subject, company or keyword"
            />
          </div>
          {type ? <input type="hidden" name="type" value={type} /> : null}
          {status ? <input type="hidden" name="status" value={status} /> : null}
        </Filters>
      </Panel>

      <div style={{ margin: "14px 0" }}>
        <Chips
          base={`/dashboard/sites/${slug}/offers`}
          param="type"
          here={{ site, q, status }}
          value={type}
          options={[
            { value: "", label: "Both" },
            { value: "sell", label: "Selling" },
            { value: "buy", label: "Buying" },
          ]}
        />{" "}
        <Chips
          base={`/dashboard/sites/${slug}/offers`}
          param="status"
          here={{ site, q, type }}
          value={status}
          options={[
            { value: "", label: "Any status" },
            { value: "published", label: "Published" },
            { value: "draft", label: "Draft" },
            { value: "suspended", label: "Suspended" },
          ]}
        />
      </div>

      <Panel title={`${count(paged.total)} offer${paged.total === 1 ? "" : "s"}`}>
        <table className="tight">
          <thead>
            <tr>
              <th>Offer</th>
              <th>Brand</th>
              <th>Who</th>
              <th>Where</th>
              <th>Who can read it</th>
              <th>Posted</th>
            </tr>
          </thead>
          <tbody>
            {paged.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <span className={`badge ${row.offer_type === "sell" ? "ok" : "warn"}`}>
                    {row.offer_type}
                  </span>{" "}
                  <Link href={`/dashboard/sites/${slug}/offers/${row.id}`}>
                    <strong>{row.subject}</strong>
                  </Link>
                  {row.offer_value ? (
                    <div className="small muted">{row.offer_value}</div>
                  ) : null}
                </td>
                <td>{row.site}</td>
                <td>
                  {row.company_name ?? <span className="muted">no company</span>}
                  <div className="small muted">
                    {row.contact_person ?? row.contact_email ?? "no contact"}
                  </div>
                </td>
                <td>{row.country ?? <span className="muted">—</span>}</td>
                <td>
                  <span className={`badge ${STATUS_TONE[row.status] ?? "brand"}`}>
                    {row.status === "premium" ? "subscribers" : row.status}
                  </span>
                </td>
                <td>
                  {when(row.created_at)}
                  {row.posted_by ? <div className="small muted">by {row.posted_by}</div> : null}
                </td>
              </tr>
            ))}
            {paged.rows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <Empty>No offers match those filters.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pager
          base={`/dashboard/sites/${slug}/offers`}
          here={{ site, type, status, q }}
          page={paged.page}
          perPage={paged.per_page}
          total={paged.total}
        />
      </Panel>
    </>
  );
}
