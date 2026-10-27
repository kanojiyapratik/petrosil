import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { planForEdit } from "@/domain/billing/plans";
import { PlanForm } from "../form";
import { Heading, one, type Search } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

export default async function PlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { id } = await params;
  const plan = await planForEdit(viewer.siteIds, Number(id));

  if (!plan) {
    notFound();
  }

  const justMade = one(await searchParams, "saved") === "1";

  return (
    <>
      <Link className="crumb" href="/dashboard/plans">
        ← Plans
      </Link>

      <Heading title={plan.name} sub={`${plan.site_names.join(", ")} · ${plan.currencies.join(" and ") || "no prices yet"}`}>
        <span className={`badge ${plan.visible ? "ok" : ""}`}>{plan.visible ? "shown" : "hidden"}</span>
        {plan.on_sale ? <span className="badge warn">on sale</span> : null}
      </Heading>

      {justMade ? (
        <p className="flash" role="status">
          Plan created.
        </p>
      ) : null}

      <PlanForm brands={await brandsFor(viewer.siteIds)} plan={plan} />
    </>
  );
}
