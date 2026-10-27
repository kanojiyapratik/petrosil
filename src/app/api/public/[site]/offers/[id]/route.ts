/**
 * GET    /api/public/{site}/offers/{id} — one live offer, with the details
 *        this reader may see.
 * PATCH  — the member who posted it changes it.
 * DELETE — the member who posted it withdraws it.
 *
 * Someone else's offer answers 404 to PATCH and DELETE, as a missing one does.
 */
import { NextResponse } from "next/server";

import { account, jsonBody } from "@/lib/auth/account";
import { idFrom, publicApi } from "@/lib/public/route";
import { liveBrand } from "@/lib/public/brand";
import { callerIp } from "@/lib/compat/auth";
import { publishedOffer } from "@/domain/public/offers";
import { updateMyOffer, withdrawMyOffer } from "@/domain/offers/member";

export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({ message: "No such offer." }, { status: 404 });

export const GET = publicApi(async ({ brand, entitlement, params }) => {
  const id = idFrom(params);
  const offer = id ? await publishedOffer(brand.id, id, entitlement) : null;

  return offer ? NextResponse.json({ site: { slug: brand.slug, name: brand.name }, entitlement, offer }) : notFound();
});

export const PATCH = account(async ({ request, identity, params }) => {
  const brand = await liveBrand(String(params.site ?? ""));
  const id = Number(params.id);
  const offer = Number.isInteger(id)
    ? await updateMyOffer(identity.user.id, brand.id, id, await jsonBody(request), { ip: callerIp(request) })
    : null;

  return offer ? NextResponse.json({ offer }) : notFound();
});

export const DELETE = account(async ({ request, identity, params }) => {
  const brand = await liveBrand(String(params.site ?? ""));
  const id = Number(params.id);
  const done = Number.isInteger(id) && (await withdrawMyOffer(identity.user.id, brand.id, id, { ip: callerIp(request) }));

  return done ? NextResponse.json({ message: "Withdrawn." }) : notFound();
});
