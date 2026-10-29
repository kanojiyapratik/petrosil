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
import { brandsFor } from "@/domain/dashboard/brands";
import { listPlans } from "@/domain/dashboard/catalogue";
import { PAYMENT_METHODS } from "@/domain/billing/manual";
import { today } from "@/domain/price/dates";
import { MembershipForm } from "./membership-form";
import { PaymentForm } from "./payment-form";
import { MemberForm } from "./member-form";
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

  const [brands, plans] = await Promise.all([brandsFor(viewer.siteIds), listPlans(viewer.siteIds)]);

  return (
    <>
      <Link className="crumb" href="/dashboard/clients">
        ← Customers
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

          <Panel
            title="Record a payment"
            flush={false}
            hint="A transfer, cheque or card payment taken by hand. It becomes a paid order on Transactions and makes them premium."
          >
            <PaymentForm
              userId={client.id}
              brands={brands}
              plans={plans}
              methods={PAYMENT_METHODS}
              defaultSite={client.brands.find((held) => brands.some((brand) => brand.slug === held.slug))?.slug ?? brands[0]?.slug ?? ""}
              defaultCurrency={(client.country ?? "").trim().toLowerCase() === "india" ? "INR" : "USD"}
              today={today()}
            />
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

        <div className="stack">
          <Panel title="Details" flush={false}>
            <dl className="kv">
              <dt>Company</dt>
              <dd>{client.company ?? "—"}</dd>
              <dt>Job title</dt>
              <dd>{client.designation ?? "—"}</dd>
              <dt>Country</dt>
              <dd>{client.country ?? "—"}</dd>
              <dt>City</dt>
              <dd>{client.city ?? "—"}</dd>
              <dt>Address</dt>
              <dd>
                {client.address ?? "—"}
                {client.postcode ? <span className="muted"> · {client.postcode}</span> : null}
              </dd>
              <dt>Phone</dt>
              <dd>{client.phone ?? "—"}</dd>
              <dt>Website</dt>
              <dd>{client.website ?? "—"}</dd>
              <dt>Registered</dt>
              <dd>{client.member_since}</dd>
              <dt>Last seen</dt>
              <dd>{client.last_login_at ? when(client.last_login_at) : "never"}</dd>
              <dt>Brands</dt>
              <dd>{client.brands.length}</dd>
            </dl>
          </Panel>

          {/* A colleague's record is a superadmin's to change. */}
          {client.segment !== "staff" || viewer.isSuperadmin ? (
            <Panel title="Edit details" flush={false}>
              <MemberForm
                userId={client.id}
                details={{
                  name: client.name,
                  company: client.company,
                  designation: client.designation ?? null,
                  phone: client.phone ?? null,
                  country: client.country,
                  city: client.city ?? null,
                  address: client.address ?? null,
                  postcode: client.postcode ?? null,
                  website: client.website ?? null,
                }}
              />
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
