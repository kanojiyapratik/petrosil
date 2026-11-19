/**
 * The admin shell: the rail, a thin top bar, and the content column.
 *
 * Refuses anyone who is not staff before a screen renders. A subscriber with
 * a perfectly good session is sent to sign in, because the admin is not
 * theirs — the same rule `requireTeam` applies to every dashboard endpoint,
 * applied once here rather than remembered on every page.
 */

import { redirect } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { railBrands } from "@/domain/dashboard/rail";
import { Rail } from "./rail";
import { BrandSwitch } from "./brand-switch";
import { brandScope } from "./brand-scope";
import { AccountMenu } from "./account-menu";
import { ThemeToggle } from "@/lib/ui/theme-toggle";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const viewer = await currentViewer();

  if (!viewer) {
    redirect("/sign-in");
  }

  // The header picker needs the brands with their price freshness; the rail
  // only counts them.
  const [brands, scope] = await Promise.all([railBrands(viewer.siteIds), brandScope(viewer)]);

  return (
    <div className="shell">
      <Rail brands={brands} />

      <div className="main">
        <header className="topbar">
          {/* The one place a brand is chosen: it filters the shared screens
              and opens a brand's own page. The rail lists no brands. */}
          <BrandSwitch brands={brands} chosen={scope.brand?.slug ?? null} />
          <span className="spacer" />
          <div className="topbar-end">
            <ThemeToggle />
            <span className="topbar-sep" aria-hidden />
            <AccountMenu
              name={viewer.identity.user.name}
              email={viewer.identity.user.email}
              role={viewer.isSuperadmin ? "Superadmin" : "Staff"}
            />
          </div>
        </header>

        <main className="content">{children}</main>
      </div>
    </div>
  );
}
