"use server";

/** A brand's sender, its test mail, and the old credentials. The rules are in `domain/mail/brand-mail.ts`. */

import { revalidatePath } from "next/cache";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { deleteOldCredentials, saveSender, sendTest } from "@/domain/mail/brand-mail";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type MailState = { error?: string; field?: string; done?: string } | null;

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

async function staff(): Promise<Viewer> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

function failed(error: unknown, what: string): MailState {
  if (error instanceof AccountError) {
    return { error: error.message, field: error.field ?? undefined };
  }

  if (error instanceof AccessError) {
    return { error: error.message };
  }

  console.error(`could not ${what}`, { error });

  return { error: "Something went wrong. Nothing was changed." };
}

export async function saveSenderAction(_state: unknown, form: FormData): Promise<MailState> {
  const viewer = await staff();
  const slug = text(form, "site");

  try {
    const sender = await saveSender(
      viewer,
      { site: slug, fromAddress: text(form, "fromAddress"), replyTo: text(form, "replyTo") },
      { ip: await callerIp() },
    );

    revalidatePath(`/dashboard/sites/${slug}/settings/mail`);

    return {
      done:
        sender.fromAddress && !sender.confirmed
          ? `Saved. Send a test from ${sender.fromAddress} before mail goes from it.`
          : "Saved.",
    };
  } catch (error) {
    return failed(error, "save a brand's sender");
  }
}

export async function sendTestAction(_state: unknown, form: FormData): Promise<MailState> {
  const viewer = await staff();
  const slug = text(form, "site");

  try {
    const sent = await sendTest(viewer, { site: slug, to: text(form, "to") }, { ip: await callerIp() });

    revalidatePath(`/dashboard/sites/${slug}/settings/mail`);

    return { done: `Sent to ${sent.to}. The brand's mail goes from ${sent.from} from now on.` };
  } catch (error) {
    return failed(error, "send a test mail");
  }
}

export async function deleteOldAction(_state: unknown, form: FormData): Promise<MailState> {
  const viewer = await staff();
  const slug = text(form, "site");

  try {
    const { removed } = await deleteOldCredentials(viewer, { site: slug }, { ip: await callerIp() });

    revalidatePath(`/dashboard/sites/${slug}/settings/mail`);

    return { done: `Deleted ${removed} old setting${removed === 1 ? "" : "s"}.` };
  } catch (error) {
    return failed(error, "delete old mail credentials");
  }
}
