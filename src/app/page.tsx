import { redirect } from "next/navigation";

/* The platform has one front door for now: the admin. The brand sites come
   later and will take their own routes. */
export default function Home() {
  redirect("/dashboard");
}
