/** The two halves of the AI entry under Global settings. */

import Link from "next/link";

export function AiTabs({ on }: { on: "providers" | "usage" }) {
  return (
    <nav className="chips" aria-label="AI" style={{ margin: "0 0 16px" }}>
      <Link className={`chip${on === "providers" ? " on" : ""}`} href="/dashboard/global/ai-providers" aria-current={on === "providers" ? "page" : undefined}>
        Providers
      </Link>
      <Link className={`chip${on === "usage" ? " on" : ""}`} href="/dashboard/global/ai-providers/usage" aria-current={on === "usage" ? "page" : undefined}>
        Usage
      </Link>
    </nav>
  );
}
