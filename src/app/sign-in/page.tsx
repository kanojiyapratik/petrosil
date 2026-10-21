import { redirect } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { SignInForm } from "./form";

export const metadata = { title: "Sign in · Petrosil" };
export const dynamic = "force-dynamic";

export default async function SignInPage() {
  // Already signed in and entitled to be here: no reason to ask again.
  if (await currentViewer()) {
    redirect("/dashboard");
  }

  return (
    <div className="signin">
      <div className="panel">
        <div className="head">
          <h1>Petrosil</h1>
        </div>
        <div className="body">
          <SignInForm />
        </div>
      </div>
    </div>
  );
}
