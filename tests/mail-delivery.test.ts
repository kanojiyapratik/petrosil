/**
 * Getting queued mail out of the building.
 *
 * The rules: a mail is sent once, even when two workers drain at the same
 * moment; a failure the provider might get over is retried later, not in a
 * hot loop; one it will never get over (an unknown template, a rejected
 * address) stops at once; and after five tries a mail is given up on, with
 * the reason kept on the row. A worker with no transport configured sends
 * nothing and loses nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { mailOutbox, sites } from "@/db/schema";
import { queueMail } from "@/lib/mail/outbox";
import { renderMail, UnknownTemplate } from "@/lib/mail/render";
import { brevoTransport, SendError, transportFromEnv, type OutgoingMail, type Transport } from "@/lib/mail/transport";
import { deliverPending, MAX_ATTEMPTS, retryDelayMinutes } from "@/lib/mail/deliver";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
});

/** A transport that records what it was handed and fails on request. */
function recorder(fail?: (mail: OutgoingMail) => Error | null): Transport & { sent: OutgoingMail[] } {
  const sent: OutgoingMail[] = [];

  return {
    name: "recorder",
    sent,
    async send(mail) {
      const error = fail?.(mail) ?? null;

      if (error) {
        throw error;
      }

      sent.push(mail);

      return { messageId: `msg-${sent.length}` };
    },
  };
}

async function queueVerify(to = "reader@company.example"): Promise<number> {
  return queueMail({
    to,
    subject: "Confirm your email address for baseoil",
    template: "verify_email",
    payload: { token: "tok123", site: "baseoil", siteName: "Base Oil Report", name: "Asha" },
    siteId: baseoil.siteId,
  });
}

/**
 * "Now" as the database tells it. A queued mail is due from the database's
 * clock, which in Docker runs a few milliseconds ahead of Node's: a test that
 * passes `new Date()` straight after queueing could find nothing due yet.
 */
async function databaseClock(): Promise<Date> {
  const [found] = (await db().execute(sql`select clock_timestamp() as now`)) as unknown as { now: Date | string }[];

  return new Date(found!.now);
}

async function row(id: number) {
  const [found] = await db().select().from(mailOutbox).where(eq(mailOutbox.id, id));

  return found!;
}

const minutes = (count: number) => count * 60_000;

describe("rendering", () => {
  it("puts the one-shot link in a verification mail", () => {
    const mail = renderMail(
      { template: "verify_email", subject: "Confirm", payload: { token: "a b", name: "Asha" } },
      { linkBase: "https://baseoilreport.com" },
    );

    expect(mail.html).toContain("https://baseoilreport.com/verify-email?token=a%20b");
    expect(mail.text).toContain("https://baseoilreport.com/verify-email?token=a%20b");
  });

  it("builds a reset link the same way", () => {
    const mail = renderMail(
      { template: "reset_password", subject: "Reset", payload: { token: "r1" } },
      { linkBase: "https://bitumart.com" },
    );

    expect(mail.html).toContain("https://bitumart.com/reset-password?token=r1");
  });

  it("escapes what a reader typed before it goes into HTML", () => {
    const mail = renderMail(
      { template: "verify_email", subject: "Confirm", payload: { token: "t", name: "<script>x</script>" } },
      { linkBase: "https://baseoilreport.com" },
    );

    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
  });

  it("refuses a template it does not know", () => {
    expect(() =>
      renderMail({ template: "nope", subject: "x", payload: {} }, { linkBase: "https://x.example" }),
    ).toThrow(UnknownTemplate);
  });
});

describe("the Brevo transport", () => {
  function fakeFetch(status: number, body: unknown) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });

      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;

    return { calls, fetcher };
  }

  const mail: OutgoingMail = {
    to: "reader@company.example",
    subject: "Hello",
    html: "<p>Hi</p>",
    text: "Hi",
    fromName: "Base Oil Report",
  };

  it("posts the message with the key in the header and returns Brevo's id", async () => {
    const { calls, fetcher } = fakeFetch(201, { messageId: "<abc@brevo>" });
    const transport = brevoTransport({ apiKey: "k-1", fromEmail: "info@petrosil.com", fetch: fetcher });

    const result = await transport.send(mail);

    expect(result.messageId).toBe("<abc@brevo>");
    expect(calls[0]!.url).toBe("https://api.brevo.com/v3/smtp/email");
    expect((calls[0]!.init.headers as Record<string, string>)["api-key"]).toBe("k-1");

    const body = JSON.parse(String(calls[0]!.init.body));

    expect(body.sender).toEqual({ email: "info@petrosil.com", name: "Base Oil Report" });
    expect(body.to).toEqual([{ email: "reader@company.example" }]);
    expect(body.htmlContent).toBe("<p>Hi</p>");
  });

  it("treats a rejected request as permanent", async () => {
    const { fetcher } = fakeFetch(400, { message: "invalid email" });
    const transport = brevoTransport({ apiKey: "k", fromEmail: "info@petrosil.com", fetch: fetcher });

    await expect(transport.send(mail)).rejects.toMatchObject({ permanent: true });
  });

  it("treats rate limiting and server errors as worth retrying", async () => {
    for (const status of [429, 500, 503]) {
      const { fetcher } = fakeFetch(status, {});
      const transport = brevoTransport({ apiKey: "k", fromEmail: "info@petrosil.com", fetch: fetcher });

      await expect(transport.send(mail)).rejects.toMatchObject({ permanent: false });
    }
  });

  it("is only configured when both the key and the sender are set", () => {
    expect(transportFromEnv({})).toBeNull();
    expect(transportFromEnv({ BREVO_API_KEY: "k" })).toBeNull();
    expect(transportFromEnv({ BREVO_API_KEY: "k", MAIL_FROM: "info@petrosil.com" })?.name).toBe("brevo");
  });
});

describe("draining the outbox", () => {
  it("sends a queued mail and records that it went", async () => {
    const id = await queueVerify();
    const transport = recorder();

    const result = await deliverPending(transport);

    expect(result).toEqual({ sent: 1, retrying: 0, failed: 0 });
    expect(transport.sent[0]!.to).toBe("reader@company.example");
    expect(transport.sent[0]!.html).toContain("token=tok123");
    // The sender's name is the brand's, so a reader sees who wrote to them.
    expect(transport.sent[0]!.fromName).toBe("baseoil");

    const sent = await row(id);

    expect(sent.sentAt).not.toBeNull();
    expect(sent.providerMessageId).toBe("msg-1");
    expect(sent.attempts).toBe(1);
  });

  it("judges what is due by the database's clock, the one that stamped the queue", async () => {
    // The queue's times come from Postgres; if the worker judged them by this
    // process's clock, any skew between the two (a Docker VM runs a few ms
    // ahead here) makes a just-queued mail look "not due yet". An hour of
    // skew makes the same mistake impossible to miss.
    await queueVerify();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 60 * 60_000);

    try {
      const result = await deliverPending(recorder());

      expect(result.sent).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never sends the same mail twice", async () => {
    await queueVerify();
    const transport = recorder();

    await deliverPending(transport);
    const second = await deliverPending(transport);

    expect(second.sent).toBe(0);
    expect(transport.sent).toHaveLength(1);
  });

  it("skips a mail another worker is claiming, without waiting for it", async () => {
    const held = await queueVerify("held@company.example");
    await queueVerify("free@company.example");
    const transport = recorder();

    // Another worker part-way through its claim holds a lock on one row. Two
    // drains started together rarely overlap that precisely, so the overlap
    // is made here: if the claim waited on the lock instead of skipping the
    // row, this would hang until the race below gives up.
    await db().transaction(async (tx) => {
      await tx.execute(sql`select id from mail_outbox where id = ${held} for update`);

      const outcome = await Promise.race([
        deliverPending(transport),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 5_000)),
      ]);

      expect(outcome).toEqual({ sent: 1, retrying: 0, failed: 0 });
    });

    expect(transport.sent.map((mail) => mail.to)).toEqual(["free@company.example"]);
    expect((await row(held)).sentAt).toBeNull();
  });

  it("puts a failed mail back for later rather than retrying at once", async () => {
    const id = await queueVerify();
    const now = await databaseClock();
    const transport = recorder(() => new SendError("Brevo answered 503", false));

    const result = await deliverPending(transport, { now });

    expect(result).toEqual({ sent: 0, retrying: 1, failed: 0 });

    const waiting = await row(id);

    expect(waiting.sentAt).toBeNull();
    expect(waiting.failedAt).toBeNull();
    expect(waiting.error).toContain("503");
    expect(waiting.nextAttemptAt.getTime()).toBe(now.getTime() + minutes(retryDelayMinutes(1)));

    // A minute later it is not due yet, so nothing is tried.
    const soon = await deliverPending(recorder(), { now: new Date(now.getTime() + minutes(1)) });

    expect(soon.sent).toBe(0);

    // Once the wait is over it goes.
    const later = await deliverPending(recorder(), {
      now: new Date(now.getTime() + minutes(retryDelayMinutes(1)) + 1),
    });

    expect(later.sent).toBe(1);
  });

  it("gives up after the last attempt and keeps the reason", async () => {
    const id = await queueVerify();
    const transport = recorder(() => new SendError("Brevo answered 500", false));
    let now = await databaseClock();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await deliverPending(transport, { now });
      now = new Date(now.getTime() + minutes(24 * 60));
    }

    const given = await row(id);

    expect(given.attempts).toBe(MAX_ATTEMPTS);
    expect(given.failedAt).not.toBeNull();
    expect(given.error).toContain("500");

    // And it is not picked up again.
    expect((await deliverPending(recorder(), { now })).sent).toBe(0);
  });

  it("stops at once on a failure that will never succeed", async () => {
    const id = await queueVerify();
    const transport = recorder(() => new SendError("Brevo answered 400: invalid email", true));

    const result = await deliverPending(transport);

    expect(result).toEqual({ sent: 0, retrying: 0, failed: 1 });
    expect((await row(id)).failedAt).not.toBeNull();
  });

  it("fails a mail with an unknown template without handing it to the provider", async () => {
    const id = await queueMail({ to: "x@company.example", subject: "?", template: "nonsense" });
    const transport = recorder();

    const result = await deliverPending(transport);

    expect(result.failed).toBe(1);
    expect(transport.sent).toHaveLength(0);
    expect((await row(id)).error).toContain("nonsense");
  });

  it("links to the brand's own domain", async () => {
    // makeBrand leaves the domain empty; the real brands carry one.
    await db().update(sites).set({ legacyDomain: "baseoilreport.com" }).where(eq(sites.id, baseoil.siteId));
    await queueVerify();
    const transport = recorder();

    await deliverPending(transport);

    expect(transport.sent[0]!.html).toContain("https://baseoilreport.com/verify-email?token=tok123");
  });
});
