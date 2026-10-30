"use client";

/** The brand's AI model, and its standing instructions to the AI. */

import { useActionState, useState } from "react";

import { chooseModelAction, type ModelSaid } from "./actions";
import { saveInstructionsAction, type Said } from "../ai-update/actions";
import type { AiSettings } from "@/domain/ai/update";

function Flash({ state }: { state: ModelSaid | Said }) {
  if (state?.error) {
    return (
      <p className="flash bad" role="alert">
        {state.error}
      </p>
    );
  }

  return state?.saved ? (
    <p className="flash" role="status">
      {state.saved}
    </p>
  ) : null;
}

export function ModelForm({ slug, settings }: { slug: string; settings: AiSettings }) {
  const [state, action, pending] = useActionState(chooseModelAction, null as ModelSaid);
  const [providerId, setProviderId] = useState(settings.provider_id ? String(settings.provider_id) : "");
  const fallback = settings.providers.find((provider) => provider.is_default);
  const chosen = settings.providers.find((provider) => String(provider.id) === providerId);
  const [model, setModel] = useState(settings.model ?? chosen?.model ?? "");

  function pick(next: string) {
    setProviderId(next);
    setModel(settings.providers.find((provider) => String(provider.id) === next)?.model ?? "");
  }

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      <Flash state={state} />
      <div className="cols">
        <div className="field">
          <label htmlFor="provider">Provider</label>
          <select id="provider" name="provider_id" value={providerId} onChange={(e) => pick(e.target.value)} disabled={!settings.canChange}>
            <option value="">The default{fallback ? ` — ${fallback.name} (${fallback.model})` : ""}</option>
            {settings.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name} · {provider.provider}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="model">Model</label>
          <select id="model" name="model" value={model} onChange={(e) => setModel(e.target.value)} disabled={!settings.canChange || !chosen}>
            {chosen ? (
              chosen.models.map((name) => (
                <option key={name} value={name}>
                  {name}
                  {name === chosen.model ? " (the provider's own)" : ""}
                </option>
              ))
            ) : (
              <option value="">{fallback?.model ?? "the default's"}</option>
            )}
          </select>
        </div>
      </div>
      {settings.canChange ? (
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          Changing the model needs the &ldquo;Change settings&rdquo; permission.
        </p>
      )}
    </form>
  );
}

export function InstructionsForm({ slug, instructions }: { slug: string; instructions: string }) {
  const [state, action, pending] = useActionState(saveInstructionsAction, null as Said);

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      <Flash state={state} />
      <div className="field">
        <label htmlFor="instructions">Instructions</label>
        <textarea
          id="instructions"
          name="instructions"
          rows={14}
          defaultValue={instructions}
          placeholder="Where in the reports this brand's prices are, which column to read, which markets to leave alone…"
        />
        <p className="small muted" style={{ margin: "6px 0 0" }}>
          Sent with every reading and draft unless the editor leaves them out for a run. Blank clears them.
        </p>
      </div>
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save the instructions"}
      </button>
    </form>
  );
}
