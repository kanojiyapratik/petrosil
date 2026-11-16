/**
 * Who is off this brand's newsletter: readers who used the link in an issue,
 * and anyone staff took off by hand. Staff can add an address (a request by
 * email or phone) or put one back.
 */

import { notFound } from "next/navigation";

import Link from "@/lib/ui/link";
import { currentViewer } from "@/lib/auth/server";
import { listOptOuts, OPT_OUT_SOURCES } from "@/domain/content/newsletter-opt-outs";
import { can, refusal } from "@/domain/staff/permissions";
import { Popup } from "@/app/(admin)/popup";
import { AddOptOutForm, PutBackForm } from "../forms";
import { Chips, Empty, Heading, ListBar, Pager, Panel, count, one, pageParam, when, type Search } from "@/app/(admin)/ui";

export const metadata = { title: "Unsubscribed · Petrosil" };
export const dynamic = "force-dynamic";

export default async function UnsubscribedPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const search = await searchParams;

  const q = one(search, "q");
  const source = one(search, "source");
  const page = pageParam(one(search, "page"));
  const done = one(search, "done");
  const refused = one(search, "refused");
  const base = `/dashboard/sites/${slug}/newsletters/unsubscribed`;

  let paged;

  try {
    paged = await listOptOuts(viewer, { site: slug, q, source, page });
  } catch (error) {
    return (
      <>
        <Heading title="Unsubscribed" />
        <p className="flash bad" role="alert">
          {refusal(error)}
        </p>
      </>
    );
  }

  if (!paged) {
    notFound();
  }

  const [mayAdd, mayPutBack] = await Promise.all([
    can(viewer, paged.siteId, "newsletter-edit"),
    can(viewer, paged.siteId, "newsletter-send"),
  ]);

  return (
    <>
      <Heading
        title="Unsubscribed"
        sub="People who will not get this brand's newsletter: those who used the unsubscribe link, and those staff took off. Their accounts and reports are not affected."
      >
        <Link className="button ghost small" href={`/dashboard/sites/${slug}/newsletters`}>
          ← Newsletters
        </Link>
        {mayAdd ? (
          <Popup label="Take someone off" title="Take someone off the newsletter">
            <AddOptOutForm site={slug} />
          </Popup>
        ) : null}
      </Heading>

      {done ? (
        <p className="flash" role="status">
          {done}
        </p>
      ) : null}
      {refused ? (
        <p className="flash bad" role="alert">
          {refused}
        </p>
      ) : null}

      <ListBar action={base} q={q} placeholder="Search: email" keep={{ source }}>
        <Chips
          base={base}
          param="source"
          here={{ q }}
          value={source}
          options={[
            { value: "", label: "All" },
            { value: "link", label: "Used the link" },
            { value: "staff", label: "Taken off by staff" },
          ]}
        />
      </ListBar>

      <Panel title={`${count(paged.total)} ${paged.total === 1 ? "address" : "addresses"}`}>
        <table className="tight">
          <thead>
            <tr>
              <th>Email</th>
              <th>How</th>
              <th>Since</th>
              {mayPutBack ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {paged.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  {row.userId ? (
                    <Link href={`/dashboard/clients/${row.userId}`}>
                      <strong>{row.email}</strong>
                    </Link>
                  ) : (
                    <strong>{row.email}</strong>
                  )}
                  {row.name ? <div className="small muted">{row.name}</div> : null}
                </td>
                <td>
                  <span className={`badge${row.source === "staff" ? "" : " warn"}`}>
                    {OPT_OUT_SOURCES[row.source as keyof typeof OPT_OUT_SOURCES] ?? row.source}
                  </span>
                </td>
                <td>{when(row.createdAt)}</td>
                {mayPutBack ? (
                  <td className="num">
                    <PutBackForm site={slug} id={row.id} email={row.email} source={row.source} />
                  </td>
                ) : null}
              </tr>
            ))}
            {paged.rows.length === 0 ? (
              <tr>
                <td colSpan={mayPutBack ? 4 : 3}>
                  <Empty>{q ? `No address has "${q}" in it.` : "Nobody has unsubscribed from this brand's newsletter."}</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pager base={base} here={{ q, source }} page={paged.page} perPage={paged.perPage} total={paged.total} />
      </Panel>
    </>
  );
}
