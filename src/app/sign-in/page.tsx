import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { DEVICE_COOKIE, linkHolder } from "@/lib/auth/session";
import { SignInForm } from "./form";
import { QuickSignIn } from "./quick";
import type { Search } from "../(admin)/ui";

export const metadata = { title: "Sign in · Petrosil" };
export const dynamic = "force-dynamic";

export default async function SignInPage({ searchParams }: { searchParams: Promise<Search> }) {
  // Already signed in and entitled to be here: no reason to ask again.
  if (await currentViewer()) {
    redirect("/dashboard");
  }

  const search = await searchParams;
  // Only a browser that has used its owner's private sign-in link.
  const holder = await linkHolder((await cookies()).get(DEVICE_COOKIE)?.value);

  return (
    <div className="signin">
      <div className="signin-col">
        <div className="panel">
          <div className="head">
            <h1>Petrosil</h1>
          </div>
          <div className="body">
            {holder ? (
              <form method="post" action="/api/auth/device" className="device-signin">
                <button type="submit" className="wide">
                  Sign in as {holder.name}
                </button>
                <span className="small muted">
                  {holder.email} · this browser is remembered.{" "}
                  <button type="submit" formAction="/api/auth/device?forget=1" className="linklike">
                    Forget it
                  </button>
                </span>
              </form>
            ) : null}
            {search.link === "busy" ? <p className="flash bad">Too many attempts. Wait a few minutes and try again.</p> : null}
            <SignInForm />
          </div>
        </div>

        {/* Draws nothing outside development. */}
        <QuickSignIn failed={search.quick === "failed"} />
      </div>
    </div>
  );
}
