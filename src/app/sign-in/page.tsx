import { redirect } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
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

  return (
    <div className="signin">
      <div className="signin-col">
        <div className="panel">
          <div className="head">
            <h1>Petrosil</h1>
          </div>
          <div className="body">
            <SignInForm />
          </div>
        </div>

        {/* Draws nothing outside development. */}
        <QuickSignIn failed={search.quick === "failed"} />
      </div>
    </div>
  );
}
