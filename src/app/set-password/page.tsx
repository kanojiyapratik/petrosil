/**
 * Where a staff invitation lands: choose a password, then sign in. The link
 * is checked when the form is sent, not here, so opening it twice is harmless.
 */

import { SetPasswordForm } from "./form";
import type { Search } from "../(admin)/ui";

export const metadata = { title: "Set your password · Petrosil" };
export const dynamic = "force-dynamic";

export default async function SetPasswordPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const token = typeof search.token === "string" ? search.token : "";

  return (
    <div className="signin">
      <div className="signin-col">
        <div className="panel">
          <div className="head">
            <h1>Set your password</h1>
          </div>
          <div className="body">
            {token ? (
              <SetPasswordForm token={token} />
            ) : (
              <p className="flash bad">This link is incomplete. Open the one in your invitation mail.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
