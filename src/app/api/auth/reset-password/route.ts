/**
 * POST /api/auth/reset-password — spend a reset link and set a new password.
 *
 * The link is checked first and spent last. Validating the password after
 * spending the token would burn the link on a typo and send the person back
 * to the forgotten-password form.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { users } from "@/db/schema";
import { jsonBody } from "@/lib/auth/account";
import { hashPassword } from "@/lib/auth/passwords";
import { revokeSessions } from "@/lib/auth/session";
import { checkPassword } from "@/domain/accounts/policy";
import { peekToken, spendToken } from "@/domain/accounts/tokens";

export const dynamic = "force-dynamic";

const expired = () =>
  NextResponse.json(
    { message: "That link is no longer valid. Ask for a new one." },
    { status: 400 },
  );

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await jsonBody(request);
    const pending = await peekToken(body.token, "reset_password");

    if (!pending) {
      return expired();
    }

    const [person] = await db().select().from(users).where(eq(users.id, pending.userId)).limit(1);

    if (!person) {
      return expired();
    }

    const check = checkPassword(body.password, person.email);

    if (!check.ok) {
      return NextResponse.json(
        { message: check.message, errors: { password: [check.message] } },
        { status: 422 },
      );
    }

    // Spending is the atomic step: two clicks arriving together, only one
    // wins, and the loser changes nothing.
    const spent = await spendToken(body.token, "reset_password");

    if (!spent) {
      return expired();
    }

    await db()
      .update(users)
      .set({ passwordHash: await hashPassword(String(body.password)), updatedAt: new Date() })
      .where(eq(users.id, person.id));

    await revokeSessions(person.id);

    return NextResponse.json({ message: "Your password is set. You can sign in now." });
  } catch (error) {
    console.error("reset-password failed", { error });

    return NextResponse.json({ message: "Something went wrong." }, { status: 500 });
  }
}
