# Petrosil dashboard demo: run-sheet

**What the client asked to see:** "how the websites, price updates, data management and
other key functions can be accessed and managed from one dashboard."

**Where:** https://petrosil-new-app-production.up.railway.app → Staff sign in (superadmin).
**Length:** about 30 minutes, plus questions.

---

## Before the call (checklist)

- [x] **Trade-analysis speed fix** deployed (890b37d): opens in ~0.8 s on live.
- [ ] **Sign in to the live app once** and leave the tab open (password reset 2 Nov 2026; mail is not set up on the live app,
      so "forgot password" will not send).
- [ ] **Fresh prices.** Every brand shows *overdue* (last published Aug–Sep), because the app holds the
      September database dumps. Pick one:
  - (a) get today's database exports from the client's production servers and reload them (best), or
  - (b) run one real AI price update on baseoil or bitumart before the call, so at least that brand is green.
- [ ] Have **the latest Argus / Lube Report PDF** for that brand on the desktop, for the live AI price update (Act 3).
- [ ] Do **not** press send on newsletters or reports during the demo: mail is not configured on the live app.
- [ ] Close other tabs; zoom the browser to 110–125% for screen sharing.

---

## Act 1: one place for all nine sites (5 min)

1. **Home page** (`/`): one card per brand, in its colour, with when its prices last moved.
   *"Every one of the nine sites, from one address."*
2. **Staff sign in → Dashboard.** The estate overview: 9 brands, 326 published markets, ~81,800 prices,
   ~87,900 registered people, 226 paying.
   - The **Brands** table: each brand's publishing cadence (weekly / 1st & 16th / fortnightly), last published,
     markets, readers, paying. *Freshness is judged against each brand's own schedule.*
3. **Left rail.** Overview / Sites / Billing / Global settings. *Nine old admins, one login.*

## Act 2: inside one brand (7 min) — use Base Oil Report

Open **Sites › Base Oil Report**. Point out the same seven tabs on every brand.

1. **Dashboard tab:** markets, prices held, readers, paying, recent prices, last price update.
2. **Prices › Markets:** 85 markets; open one to show its price history and chart; show/hide a market.
3. **Prices › Enter prices / Correct a whole date:** manual entry is still there when needed.
4. **Content:** Articles, Reports, Impex sheets, Offers — the archive carried over in full
   (~92,700 articles, ~3,600 reports across the brands).
5. **Emailer › Newsletters:** the archive of past issues; compose from a template (do not send).
6. **Readers › Enquiries:** messages to companies, offers and plans now land in one inbox per brand — *on the old
   sites the contact messages were stored but no admin screen ever showed them.*

Then switch to **Bitumart** in the rail: same tabs, its own data. *Learn it once, use it nine times.*

## Act 3: price automation, in the dashboard (8 min) — the centrepiece

On the brand's **AI tools** tab:

1. **AI price update:** upload the report PDF → the AI reads every price (a few seconds) → **Draft** (about
   30 s with GPT-4.1) → the draft table: old price, new price, change, the rule or reading behind each row,
   preflight warnings flagged for the editor.
   - Show a warning row and how the editor fixes or accepts it.
   - **Save** stages it as a price update; **Price update** shows it; **Commit** publishes it. (Commit only if
     the figures are real — otherwise **Discard**.)
2. **Per-market rules:** prices worked out from others (baseoil: 87 rules) and rounding (bitumart: to 5,
   plus 21 market-specific roundings). *This is where the freight-based CFR idea (their point 4) will live.*
3. **Watched pages:** the 7 public sources baseoil watches; **Check now**; *the crawler checks every 15 minutes
   and suggests matches, it never publishes on its own.*
4. **Published AI note:** the short note above the prices.
5. **AI settings:** the model and the standing instructions per brand (bitumart's Argus reading rules).

Global: **Global settings › AI settings:** the provider (GPT-4.1), **Test it**, and usage per brand and per day.

## Act 4: people, billing, settings (5 min)

1. **People:** Customers (one person, one account, across all nine brands — the old estate had up to nine
   accounts per person), Trial requests, Petrosil team, **Roles** (who may do what), Sign-ins.
2. **Billing:** Plans and pricing (India subcontinent in INR, everyone else in USD), Payments, Coupons.
3. **Global settings:** Site defaults, System emails, Common pages, Field visibility (what free vs paying readers
   see), Ad slots, Categories, Currencies. *Set once, applied to the brands ticked.*
4. **Activity:** the audit trail — who changed what, when.

## Act 5: where this goes next (5 min) — tie to their email

- **AI Market Insights (their 1):** the public page already exists (`/baseoil/ai-market-insights`); the
  commentary would be drafted by the same engine after each price update, reviewed in the AI tools tab, then
  published there and reused in newsletters.
- **Volume trends (their 2):** **Trade analysis** on baseoil already holds monthly import/export flows going back
  years (~64,000 import and ~57,000 export rows); month-on-month and year-on-year changes and charts build on it.
- **Freight-based CFR prices (their 4):** a freight-rate table plus rules of the kind already in
  *Per-market rules* (FOB + freight + adjustments), cross-checked against quotations, published after approval.

Close: *"All of this runs on the same price-automation engine you already use — nothing new to learn."*

---

## Things not to open (or say plainly if asked)

| Screen / question | Honest answer |
|---|---|
| Sending a newsletter or a report | Built; live sending is switched on once the mail account is connected. |
| Taking a payment | Payment screen shows history; Razorpay is connected at go-live. |
| Public sites' sign-up and checkout | Brand pages exist in the new app; the old sites stay live until switchover. |
| "Why is everything overdue?" | The demo data is the September copy (unless refreshed — see checklist). |
| Trade analysis on brands other than baseoil | Only baseoil ever had it; the volume work would extend it. |
