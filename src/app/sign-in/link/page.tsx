/**
 * /sign-in/link#<secret> — a private, bookmarkable way in for staff.
 *
 * The secret rides after the `#`, which a browser never sends to a server,
 * so it is in no request log; this page reads it and posts it once. Anyone
 * without the link sees nothing but a pointer to the ordinary sign-in.
 */

import { LinkSignIn } from "./sign-in";

export const metadata = { title: "Sign in · Petrosil", robots: { index: false } };

export default function LinkSignInPage() {
  return (
    <div className="signin">
      <div className="signin-col">
        <div className="panel">
          <div className="head">
            <h1>Petrosil</h1>
          </div>
          <div className="body">
            <LinkSignIn />
          </div>
        </div>
      </div>
    </div>
  );
}
