/** One listed company, showing what this reader may see, and a way to write to it. */

import Link from "next/link";
import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { directoryEntry } from "@/domain/public/directory";
import { liveBrandBySlug, readerFor } from "@/lib/public/reader";
import { MessageBox } from "../../contact";
import { Gate } from "../../ui";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ site: string; id: string }> };

const load = cache(async (site: string, id: string) => {
  const brand = await liveBrandBySlug(site);
  const number = Number(id);

  if (!brand || !Number.isInteger(number) || number < 1) {
    return null;
  }

  const reader = await readerFor(brand.id);
  const company = await directoryEntry(brand.id, number, reader.entitlement);

  return company ? { reader, company } : null;
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site, id } = await params;
  const found = await load(site, id);

  return found ? { title: found.company.company ?? "Member company" } : {};
}

/** A website as a link only when it is one: the field is free text. */
function site(value: string): string | null {
  const href = /^https?:\/\//i.test(value) ? value : `https://${value}`;

  try {
    const url = new URL(href);

    return url.hostname.includes(".") ? url.toString() : null;
  } catch {
    return null;
  }
}

export default async function Company({ params }: Props) {
  const { site: brand, id } = await params;
  const found = await load(brand, id);

  if (!found) {
    notFound();
  }

  const { company, reader } = found;
  const website = company.website ? site(company.website) : null;
  const rows: [string, React.ReactNode][] = [
    ["Contact", [company.person, company.designation].filter(Boolean).join(", ") || null],
    ["Address", [company.address, company.postcode].filter(Boolean).join(", ") || null],
    ["City", company.city],
    ["Country", company.country],
    [
      "Website",
      company.website ? (
        website ? (
          <a href={website} target="_blank" rel="noopener nofollow">
            {company.website}
          </a>
        ) : (
          company.website
        )
      ) : null,
    ],
    ["Email", company.email ? <a href={`mailto:${company.email}`}>{company.email}</a> : null],
    ["Phone", company.phone],
  ];
  const shown = rows.filter(([, value]) => value);

  return (
    <article className="bs-card">
      <Link className="bs-crumb" href={`/${brand}/directory`}>
        ← Directory
      </Link>
      <h1 style={{ fontSize: "clamp(24px, 3.4vw, 32px)" }}>
        {company.company ?? "A member company"}
        {company.premium_member ? <span className="bs-tag">Premium member</span> : null}
      </h1>

      {shown.length > 0 ? (
        <dl className="bs-facts">
          {shown.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <Gate site={brand} entitlement={reader.entitlement} lead="Full company details, and writing to companies through the site, are for subscribers." />

      {company.can_contact && reader.viewer.userId !== null ? (
        <MessageBox
          site={brand}
          kind="company"
          to={company.id}
          allowed={company.can_contact}
          signedIn={reader.viewer.userId !== null}
          back={`/${brand}/directory/${company.id}`}
          title={`Write to ${company.company ?? "this company"}`}
        />
      ) : null}
    </article>
  );
}
