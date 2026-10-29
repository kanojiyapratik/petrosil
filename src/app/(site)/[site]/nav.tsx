"use client";

/** The brand's menu. Client-side only to know which section is open. */

import Link from "next/link";
import { usePathname } from "next/navigation";

const SECTIONS = [
  { path: "price-trends", label: "Prices", also: ["locations"] },
  { path: "ai-market-insights", label: "AI insights", also: [] },
  { path: "articles", label: "Articles", also: [] },
  { path: "reports", label: "Reports", also: [] },
  { path: "impex", label: "Impex", also: ["analytics"] },
  { path: "directory", label: "Directory", also: [] },
  { path: "offers", label: "Offers", also: [] },
];

export function BrandNav({ site }: { site: string }) {
  const section = usePathname().split("/")[2] ?? "";

  return (
    <nav className="bs-nav" aria-label="Sections">
      {SECTIONS.map((item) => (
        <Link
          key={item.path}
          href={`/${site}/${item.path}`}
          aria-current={item.path === section || item.also.includes(section) ? "page" : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
