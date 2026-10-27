import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { couponForEdit } from "@/domain/billing/coupons";
import { CouponForm } from "../form";
import { Heading, Panel } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

export default async function CouponPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = (await currentViewer())!;
  const { id } = await params;
  const coupon = await couponForEdit(viewer.siteIds, Number(id));

  if (!coupon) {
    notFound();
  }

  return (
    <>
      <Link className="crumb" href="/dashboard/coupons">
        ← Coupons
      </Link>

      <Heading title={coupon.code} sub={coupon.site ? `Works on ${coupon.site}` : "Works on every brand"} />

      <Panel title="The code" flush={false} hint="Switch a code off rather than deleting it: paid orders point at it.">
        <CouponForm brands={await brandsFor(viewer.siteIds)} coupon={coupon} superadmin={viewer.isSuperadmin} />
      </Panel>
    </>
  );
}
