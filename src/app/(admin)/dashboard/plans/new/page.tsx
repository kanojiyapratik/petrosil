import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { PlanForm } from "../form";
import { Heading } from "@/app/(admin)/ui";

export const metadata = { title: "New plan · Petrosil" };
export const dynamic = "force-dynamic";

export default async function NewPlanPage() {
  const viewer = (await currentViewer())!;

  return (
    <>
      <Link className="crumb" href="/dashboard/plans">
        ← Plans
      </Link>

      <Heading title="New plan" sub="Shown on the ticked brands as soon as it is saved, unless you untick Shown." />

      <PlanForm brands={await brandsFor(viewer.siteIds)} />
    </>
  );
}
