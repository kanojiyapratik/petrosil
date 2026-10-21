/**
 * One-click sign-in, as a second card beneath the login one.
 *
 * Renders nothing outside development — `adminAccounts` returns an empty
 * list there and this draws nothing, so there is no arrangement of
 * environment variables in which a production sign-in page lists the people
 * who can get in.
 *
 * Each row carries what you would otherwise have to remember: who the
 * account is, the address you would be typing, and exactly what they can
 * see. That last part is the point of keeping two of them — staff see one
 * brand, a superadmin sees nine — and it is the thing you check by switching
 * between them.
 */

import { adminAccounts } from "@/lib/auth/dev-sign-in";
import { quickSignIn } from "../(admin)/actions";

/** What this account can see, in the fewest words that are still true. */
function sees(account: { role: "superadmin" | "staff"; brands: string[] }): string {
  if (account.role === "superadmin") {
    return `every brand · ${account.brands.length}`;
  }

  if (account.brands.length === 1) {
    return `${account.brands[0]} only`;
  }

  return `${account.brands.length} brands`;
}

export async function QuickSignIn({ failed }: { failed?: boolean }) {
  const accounts = await adminAccounts();

  if (accounts.length === 0) {
    return null;
  }

  return (
    <div className="panel quick">
      <div className="head">
        <h2>Sign in as</h2>
        <span className="spacer" />
        <span className="badge">development only</span>
      </div>

      <div className="body flush">
        {failed ? (
          <p className="flash bad" role="alert">
            That did not work — the password may no longer be the development one.
          </p>
        ) : null}

        {accounts.map((account) => (
          <form action={quickSignIn} key={account.id}>
            <input type="hidden" name="email" value={account.email} />
            <button className="quick-one" type="submit">
              <span className="quick-who">
                <strong>{account.name}</strong>
                <span>{account.email}</span>
              </span>
              <span className="quick-sees">
                <span className={account.role === "superadmin" ? "role boss" : "role"}>
                  {account.role}
                </span>
                <span>{sees(account)}</span>
              </span>
            </button>
          </form>
        ))}
      </div>

      <div className="quick-foot">
        Goes through the same sign-in as above, so it is throttled and logged. Hidden when{" "}
        <code>NODE_ENV=production</code>.
      </div>
    </div>
  );
}
