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
import { Rail } from "./rail";
import { signOut } from "./actions";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const viewer = await currentViewer();

  if (!viewer) {
    redirect("/sign-in");
  }

  const brands = viewer.isSuperadmin
    ? viewer.identity.memberships.length
    : viewer.siteIds.length;

  return (
    <div className="shell">
      <Rail brands={brands} />

      <div className="main">
        <header className="topbar">
          <span className="badge brand">
            {viewer.isSuperadmin ? "Superadmin" : "Staff"}
          </span>
          <span className="spacer" />
          <span className="who">
            <strong>{viewer.identity.user.name}</strong>
            <span>{viewer.identity.user.email}</span>
          </span>
          <form action={signOut}>
            <button className="ghost" type="submit">
              Sign out
            </button>
          </form>
        </header>

        <main className="content">{children}</main>
      </div>
    </div>
  );
}
