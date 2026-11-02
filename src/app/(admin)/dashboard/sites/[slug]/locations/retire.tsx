"use client";

import { retireLocationAction } from "./actions";

/** Asks first: the market leaves the site, the price module and the crawler. */
export function RetireMarket({ slug, id, title, prices }: { slug: string; id: number; title: string; prices: number }) {
  return (
    <form
      action={retireLocationAction}
      onSubmit={(event) => {
        const kept = prices === 1 ? "Its 1 price is kept" : `Its ${prices.toLocaleString("en-IN")} prices are kept`;

        if (!window.confirm(`Retire "${title}"? It leaves the markets list, the website, the price module and the crawler. ${kept} in the history.`)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="id" value={id} />
      <button className="ghost small" type="submit">
        Retire this market
      </button>
    </form>
  );
}
