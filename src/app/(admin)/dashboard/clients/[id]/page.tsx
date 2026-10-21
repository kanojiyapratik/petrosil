/**
 * One client, and the controls the team actually uses on them: extend a
 * subscription, change a tier, switch the account off.
 *
 * The recent sign-ins are here rather than on the login screen because the
 * question is nearly always about one person — "they say they cannot get in"
 * — and ten rows answers it.
 */

import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { clientDetail } from "@/domain/dashboard/clients";
import { MembershipForm } from "./membership-form";
import { Empty, Heading, Panel, when } from "../../../ui";

export const dynamic = "force-dynamic";

const TONE: Record<string, string> = {
  premium: "ok",
  trial: "warn",
  expired: "bad",
  free: "",
  staff: "brand",
};

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = (await currentViewer())!;
  const { id } = await params;

  const client = await clientDetail(viewer.siteIds, Number(id));

  if (!client) {
    notFound();
  }

  return (
    <>
      <Link className="crumb" href="/dashboard/clients">
        ← Directory
      </Link>

      <Heading title={client.name} sub={client.email}>
        <span className={`badge ${TONE[client.segment] ?? ""}`}>{client.segment}</span>
        <span className={`badge ${client.status === "active" ? "ok" : "bad"}`}>{client.status}</span>
      </Heading>

      <div className="cols wide">
        <div>
          <Panel title="Subscriptions" flush={false} hint="One brand at a time, on purpose.">
            {client.brands.length === 0 ? (
              <Empty>This person reads none of your brands.</Empty>
            ) : (
              client.brands.map((brand) => (
                <div key={brand.slug} style={{ marginBottom: 18 }}>
                  <div className="heading">
                    <h3>{brand.name}</h3>
                    <span className="spacer" />
                    <span className="tag">{brand.role}</span>
                  </div>
                  <MembershipForm userId={client.id} brand={brand} />
                </div>
              ))
            )}
          </Panel>

          <Panel title="Recent sign-ins">
            <table className="tight">
              <thead>
                <tr>
                  <th>When</th>
                  <th>From</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {client.recent_logins.map((row, at) => (
                  <tr key={`${row.at}-${at}`}>
                    <td>{when(row.at)}</td>
                    <td>{row.ip ?? <span className="muted">unknown</span>}</td>
                    <td>
                      <span className={`badge ${row.ok ? "ok" : "bad"}`}>
                        {row.ok ? "in" : "refused"}
                      </span>
                    </td>
                  </tr>
                ))}
                {client.recent_logins.length === 0 ? (
                  <tr>
                    <td colSpan={3}>
                      <Empty>No sign-in has ever been attempted on this account.</Empty>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </Panel>
        </div>

        <Panel title="Details" flush={false}>
          <dl className="kv">
            <dt>Company</dt>
            <dd>{client.company ?? "—"}</dd>
            <dt>Country</dt>
            <dd>{client.country ?? "—"}</dd>
            <dt>Registered</dt>
            <dd>{client.member_since}</dd>
            <dt>Last seen</dt>
            <dd>{client.last_login_at ? when(client.last_login_at) : "never"}</dd>
            <dt>Brands</dt>
            <dd>{client.brands.length}</dd>
          </dl>
        </Panel>
      </div>
    </>
  );
}
