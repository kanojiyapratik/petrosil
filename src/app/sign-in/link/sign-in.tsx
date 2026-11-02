"use client";

import { useEffect, useRef, useState } from "react";

import Link from "@/lib/ui/link";

export function LinkSignIn() {
  const [failed, setFailed] = useState<string | null>(null);
  // React runs effects twice in development; the secret is posted once.
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) {
      return;
    }

    sent.current = true;
    const secret = new URLSearchParams(window.location.hash.slice(1)).get("k");

    // Off the address bar at once, whatever happens next.
    window.history.replaceState(null, "", "/sign-in/link");

    if (!secret) {
      setFailed("This page needs a sign-in link.");
      return;
    }

    fetch("/api/auth/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret }),
    })
      .then(async (response) => {
        if (response.ok) {
          window.location.replace("/dashboard");
          return;
        }

        const said = (await response.json().catch(() => ({}))) as { message?: string };
        setFailed(said.message ?? "This sign-in link does not work.");
      })
      .catch(() => setFailed("Could not reach the server. Try again."));
  }, []);

  if (failed) {
    return (
      <>
        <p className="flash bad">{failed}</p>
        <Link href="/sign-in" className="button">
          Sign in with email and password
        </Link>
      </>
    );
  }

  return <p className="hint">Signing you in…</p>;
}
