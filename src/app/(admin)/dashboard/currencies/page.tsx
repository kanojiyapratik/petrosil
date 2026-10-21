/**
 * Currencies.
 *
 * One list for the estate, where the old schema had nine three-row tables
 * with nothing keeping them in step. The count of locations priced in each
 * is what makes the list actionable: a currency nothing uses can go, and a
 * currency a location names but this list does not have is a bug worth
 * seeing — so that is called out rather than left to be discovered.
 */

import { currentViewer } from "@/lib/auth/server";
import { listCurrencies, unknownCurrencies } from "@/domain/dashboard/masters";
import { Empty, Heading, Panel, count } from "../../ui";

export const metadata = { title: "Currencies · Petrosil" };
export const dynamic = "force-dynamic";

export default async function CurrenciesPage() {
  await currentViewer();

  const [rows, stranded] = await Promise.all([listCurrencies(), unknownCurrencies()]);

  return (
    <>
      <Heading
        title="Currencies"
        sub="One list for the whole estate. A location names its currency by code."
      />

      {stranded.length > 0 ? (
        <div className="note" style={{ marginBottom: 16 }}>
          <strong>{stranded.length}</strong> code{stranded.length === 1 ? "" : "s"} used by
          locations but not in this list: {stranded.map((code) => code || "(blank)").join(", ")}.
          Prices in them still publish; nothing can format them.
        </div>
      ) : null}

      <Panel title={`${count(rows.length)} currenc${rows.length === 1 ? "y" : "ies"}`}>
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Symbol</th>
              <th>Offered</th>
              <th className="num">Locations priced in it</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>
                    <code>{row.code}</code>
                  </strong>
                </td>
                <td>{row.title}</td>
                <td>{row.symbol}</td>
                <td>
                  <span className={`badge ${row.enabled ? "ok" : ""}`}>
                    {row.enabled ? "yes" : "retired"}
                  </span>
                </td>
                <td className="num">
                  {row.locations === 0 ? (
                    <span className="muted">unused</span>
                  ) : (
                    count(row.locations)
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <Empty>No currencies in the master list yet.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
