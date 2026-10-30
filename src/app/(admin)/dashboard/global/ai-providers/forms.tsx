"use client";

/**
 * A provider's row, and the form that adds one. A key is typed in once and
 * never shown again: the row carries only its masked ends, and saving a
 * row with the key box left empty keeps the key that is stored.
 */

import { useActionState, useState, useTransition } from "react";

import {
  addProviderAction,
  checkKeyAction,
  providerButtonAction,
  updateProviderAction,
  type ProviderSaid,
} from "./actions";
import type { Provider } from "@/domain/ai/providers";

function Flash({ state }: { state: ProviderSaid }) {
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

export function ProviderCard({ provider }: { provider: Provider }) {
  const [saved, save, saving] = useActionState(updateProviderAction, null as ProviderSaid);
  const [pressed, press, pressing] = useActionState(providerButtonAction, null as ProviderSaid);
  const busy = saving || pressing;

  return (
    <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14, marginTop: 14 }}>
      <div className="bar" style={{ marginBottom: 8 }}>
        <strong>{provider.name}</strong>
        <span className="tag">{provider.label}</span>
        {provider.is_default ? <span className="badge ok">default</span> : null}
        {!provider.enabled ? <span className="badge">turned off</span> : null}
        <span className="small muted">
          key {provider.masked_key}
          {provider.sites.length ? ` · chosen by ${provider.sites.join(", ")}` : ""}
        </span>
      </div>

      <Flash state={pressed ?? saved} />

      <form action={save}>
        <input type="hidden" name="id" value={provider.id} />
        <div className="cols">
          <div className="field">
            <label htmlFor={`name-${provider.id}`}>Name</label>
            <input id={`name-${provider.id}`} name="name" type="text" defaultValue={provider.name} />
          </div>
          <div className="field">
            <label htmlFor={`model-${provider.id}`}>Model</label>
            <select id={`model-${provider.id}`} name="model" defaultValue={provider.model}>
              {provider.models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`key-${provider.id}`}>Replace the key</label>
            <input id={`key-${provider.id}`} name="api_key" type="password" autoComplete="off" placeholder="leave empty to keep it" />
          </div>
          <div className="field" style={{ alignSelf: "end" }}>
            <label className="check">
              <input type="checkbox" name="enabled" defaultChecked={provider.enabled} />
              In use
            </label>
          </div>
        </div>
        <div className="actions">
          <button type="submit" className="small" disabled={busy}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>

      <form action={press} className="actions" style={{ marginTop: 8 }}>
        <input type="hidden" name="id" value={provider.id} />
        <button type="submit" name="intent" value="test" className="ghost small" disabled={busy}>
          {pressing ? "Working…" : "Test it"}
        </button>
        {!provider.is_default ? (
          <button type="submit" name="intent" value="default" className="ghost small" disabled={busy}>
            Make it the default
          </button>
        ) : null}
        {!provider.is_default ? (
          <button
            type="submit"
            name="intent"
            value="remove"
            className="ghost small"
            disabled={busy}
            onClick={(event) => {
              if (!window.confirm(`Remove ${provider.name}? Brands that chose it go back to the default.`)) {
                event.preventDefault();
              }
            }}
          >
            Remove
          </button>
        ) : null}
      </form>
    </div>
  );
}

export function AddProvider({ catalogue }: { catalogue: Record<string, { label: string; key_hint: string }> }) {
  const [state, action, pending] = useActionState(addProviderAction, null as ProviderSaid);
  const [provider, setProvider] = useState(Object.keys(catalogue)[0] ?? "");
  const [key, setKey] = useState("");
  const [checked, setChecked] = useState<{ models: string[] } | { error: string } | null>(null);
  const [checking, start] = useTransition();

  function check() {
    start(async () => setChecked(await checkKeyAction({ provider, apiKey: key })));
  }

  return (
    <form action={action}>
      <Flash state={state} />
      <div className="cols">
        <div className="field">
          <label htmlFor="new-provider">Provider</label>
          <select id="new-provider" name="provider" value={provider} onChange={(e) => (setProvider(e.target.value), setChecked(null))}>
            {Object.entries(catalogue).map(([key, entry]) => (
              <option key={key} value={key}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="new-name">Name (optional)</label>
          <input id="new-name" name="name" type="text" placeholder={catalogue[provider]?.label} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="new-key">API key</label>
        <input
          id="new-key"
          name="api_key"
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => (setKey(e.target.value), setChecked(null))}
          required
        />
        <p className="small muted" style={{ margin: "4px 0 0" }}>
          {catalogue[provider]?.key_hint}
        </p>
      </div>
      {checked ? (
        "error" in checked ? (
          <p className="flash bad">{checked.error}</p>
        ) : (
          <p className="flash">That key works. It can run {checked.models.length} model{checked.models.length === 1 ? "" : "s"}, e.g. {checked.models.slice(0, 4).join(", ")}.</p>
        )
      ) : null}
      <label className="check" style={{ marginBottom: 12 }}>
        <input type="checkbox" name="make_default" /> Make it the default for every brand that has not chosen its own
      </label>
      <div className="actions">
        <button type="button" className="ghost" onClick={check} disabled={checking || key.trim() === ""}>
          {checking ? "Checking…" : "Check the key"}
        </button>
        <button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add the provider"}
        </button>
      </div>
    </form>
  );
}
