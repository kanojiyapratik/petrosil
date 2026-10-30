/**
 * Talking to the AI engine (engine/, Python).
 *
 * The engine does the AI work for a brand's AI tools tab and draws no
 * screens. It trusts this app: the app has already decided the person may
 * use the brand's AI tools, and names them in `X-Acting-User` so the engine's
 * own audit trail and its kept drafts still say who did what.
 *
 * Node's `http` rather than `fetch`: fetch gives up waiting for response
 * headers after five minutes, and a draft read off picture pages has taken
 * four. The limit here is the caller's, per call.
 */

import http from "node:http";
import https from "node:https";

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Set when a reading was already used: what "use these prices again" needs. */
    readonly reuse: { set_id: number; pricedate: string; used_at: string } | null = null,
  ) {
    super(message);
  }
}

type Call = {
  method?: "GET" | "POST" | "PUT" | "PATCH";
  json?: unknown;
  form?: FormData;
  /** The staff member's email, for the engine's audit trail. */
  actor: string;
  /** How long to wait, in ms. Reading and drafting run several model calls. */
  timeout?: number;
};

function config(): { base: URL; token: string } {
  const url = process.env.ENGINE_URL?.trim();
  const token = process.env.ENGINE_TOKEN?.trim();

  if (!url || !token) {
    throw new EngineError("The AI engine is not set up on this server.", 503);
  }

  return { base: new URL(url.endsWith("/") ? url : `${url}/`), token };
}

/** The body and its content type, multipart built the way fetch would. */
async function encode(call: Call): Promise<{ body?: Buffer; type?: string }> {
  if (call.form) {
    const request = new Request("http://engine.local/", { method: "POST", body: call.form });

    return { body: Buffer.from(await request.arrayBuffer()), type: request.headers.get("content-type") ?? undefined };
  }

  if (call.json !== undefined) {
    return { body: Buffer.from(JSON.stringify(call.json)), type: "application/json" };
  }

  return {};
}

function send(
  url: URL,
  options: { method: string; headers: Record<string, string>; body?: Buffer; timeout: number },
): Promise<{ status: number; type: string; body: Buffer }> {
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(url, { method: options.method, headers: options.headers }, (response) => {
      const chunks: Buffer[] = [];

      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 502,
          type: String(response.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks),
        }),
      );
      response.on("error", reject);
    });

    // A socket that goes quiet for the whole allowance is given up on; one
    // that is still answering is not.
    request.setTimeout(options.timeout, () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end(options.body);
  });
}

async function raw(slug: string, path: string, call: Call): Promise<{ status: number; type: string; body: Buffer }> {
  const { base, token } = config();
  const url = new URL(`api/engine/sites/${encodeURIComponent(slug)}/${path}`, base);
  const { body, type } = await encode(call);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "x-acting-user": call.actor,
    accept: "application/json",
  };

  if (type) {
    headers["content-type"] = type;
  }

  if (body) {
    headers["content-length"] = String(body.length);
  }

  try {
    return await send(url, { method: call.method ?? "GET", headers, body, timeout: call.timeout ?? 60_000 });
  } catch (error) {
    const timedOut = error instanceof Error && error.message === "timeout";

    console.error("the AI engine did not answer", { path, error });

    throw new EngineError(
      timedOut
        ? "The AI engine took too long to answer. Nothing was lost — open this brand's AI price update again."
        : "The AI engine could not be reached. Try again in a minute.",
      timedOut ? 504 : 502,
    );
  }
}

/** One JSON call to the engine for one brand. Refusals arrive as EngineError with the engine's own words. */
export async function engine<T>(slug: string, path: string, call: Call): Promise<T> {
  const answer = await raw(slug, path, call);
  const text = answer.body.toString("utf8");
  let parsed: unknown = null;

  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (answer.status >= 400) {
    const said = parsed as { error?: string; detail?: string; reuse?: EngineError["reuse"] } | null;

    // 401 means this server's ENGINE_TOKEN is wrong: a setup fault, never
    // the person's, so it is not passed on in the engine's words.
    if (answer.status === 401) {
      console.error("the AI engine refused this server's token");

      throw new EngineError("The AI engine is not set up on this server.", 503);
    }

    throw new EngineError(said?.error ?? said?.detail ?? "The AI engine could not do that.", answer.status, said?.reuse ?? null);
  }

  return parsed as T;
}

/** A file the engine produces (the workings sheet), passed through as it is. */
export async function engineFile(slug: string, path: string, actor: string): Promise<{ type: string; body: Buffer }> {
  const answer = await raw(slug, path, { actor });

  if (answer.status >= 400) {
    throw new EngineError("That file could not be produced.", answer.status);
  }

  return { type: answer.type, body: answer.body };
}
