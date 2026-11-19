/**
 * Where a newsletter's unsubscribe link lands. Opening it changes nothing — a
 * mail system's link scanner opens every link — the button does.
 */

import { lookUpUnsubscribe } from "@/domain/content/newsletter-send";
import type { Search } from "../../(admin)/ui";
import { ThemeToggle } from "@/lib/ui/theme-toggle";

export const metadata = { title: "Newsletter · Unsubscribe", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Search>;
}) {
  const { token } = await params;
  const search = await searchParams;
  const found = await lookUpUnsubscribe(token);
  const action = `/api/public/unsubscribe/${encodeURIComponent(token)}`;

  return (
    <div className="signin">
      <ThemeToggle className="corner" />
      <div className="signin-col">
        <div className="panel">
          <div className="head">
            <h1>{found ? `${found.siteName} newsletter` : "Unsubscribe"}</h1>
          </div>
          <div className="body">
            {!found ? (
              <p className="flash bad">This link is not one we know. Open the unsubscribe link in the newsletter itself.</p>
            ) : found.optedOut ? (
              <>
                <p className="flash" role="status">
                  {search.done ? "Done. " : ""}
                  <strong>{found.email}</strong> will not get the {found.siteName} newsletter any more.
                </p>
                <p className="small muted">
                  Mails about your account and anything you have paid for still come. Changed your mind?
                </p>
                <form method="post" action={action}>
                  <input type="hidden" name="again" value="1" />
                  <button type="submit" className="ghost">
                    Subscribe again
                  </button>
                </form>
              </>
            ) : (
              <>
                {search.back ? (
                  <p className="flash" role="status">
                    Welcome back: you are on the newsletter again.
                  </p>
                ) : null}
                <p>
                  Stop sending the {found.siteName} newsletter to <strong>{found.email}</strong>?
                </p>
                <form method="post" action={action}>
                  <button type="submit">Unsubscribe</button>
                </form>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
