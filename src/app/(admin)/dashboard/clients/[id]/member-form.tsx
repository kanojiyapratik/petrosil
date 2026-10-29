"use client";

/**
 * Correcting a member's details, as the old directory editor did. The email
 * is not here: it is their sign-in, and changing it needs the new address
 * confirmed.
 */

import { useActionState } from "react";

import { COUNTRIES } from "@/domain/geo/countries";
import { editMemberAction, type MemberResult } from "./actions";

type Details = {
  name: string;
  company: string | null;
  designation: string | null;
  phone: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  postcode: string | null;
  website: string | null;
};

const FIELDS: { name: keyof Details; label: string; max: number; wide?: boolean }[] = [
  { name: "name", label: "Name", max: 191, wide: true },
  { name: "company", label: "Company", max: 191, wide: true },
  { name: "designation", label: "Job title", max: 191 },
  { name: "phone", label: "Phone", max: 64 },
  { name: "city", label: "City", max: 96 },
  { name: "country", label: "Country", max: 96 },
  { name: "postcode", label: "Postcode", max: 32 },
  { name: "website", label: "Website", max: 191 },
];

export function MemberForm({ userId, details }: { userId: number; details: Details }) {
  const [state, action, pending] = useActionState(editMemberAction, null as MemberResult);

  return (
    <form action={action}>
      <input type="hidden" name="user_id" value={userId} />

      {state?.error ? (
        <p className="flash bad" role="alert">
          {state.error}
        </p>
      ) : null}
      {state?.saved ? (
        <p className="flash" role="status">
          {state.saved}
        </p>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
        <datalist id="member-countries">
          {COUNTRIES.map((country) => (
            <option key={country.code} value={country.name} />
          ))}
        </datalist>
        {FIELDS.map((field) => (
          <div className="field" key={field.name} style={field.wide ? { gridColumn: "1 / -1" } : undefined}>
            <label htmlFor={`member-${field.name}`}>{field.label}</label>
            <input
              id={`member-${field.name}`}
              name={field.name}
              type="text"
              maxLength={field.max}
              required={field.name === "name"}
              defaultValue={details[field.name] ?? ""}
              aria-invalid={state?.field === field.name || undefined}
              list={field.name === "country" ? "member-countries" : undefined}
            />
          </div>
        ))}
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <label htmlFor="member-address">Address</label>
          <textarea id="member-address" name="address" rows={3} maxLength={2000} defaultValue={details.address ?? ""} style={{ minHeight: 0 }} />
        </div>
      </div>

      <div className="actions">
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save details"}
        </button>
        <span className="small muted">The email is their sign-in and is not changed here.</span>
      </div>
    </form>
  );
}
