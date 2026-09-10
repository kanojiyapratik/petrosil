# Two-step editorial upload — design (2026-09-10)

Asked for by the owner in chat, 2026-09-10: *"first we will let user upload
maximum 5 files and one by one its extracted by AI then all files extracted
data is shown on the screen separately and user will review and then he will
push the entire extracted data to AI together and then the analysis will
happen on that."* Asked which shape step 1 should show and he answered:
**as printed**.

## The problem this solves

Today the whole editorial update is one request. Up to five reports are read,
their text is concatenated into one block, and that block plus all the site's
location names goes to the model in a single prompt.

Three consequences, all measured:

- **The model skims it.** On the 19.08 Lube Report the combined prompt is 65k
  characters and gpt-4o-mini returned **0 direct suggestions across 47
  locations**. The same problem was already proved and already solved once in
  miniature: `app/editorial/benchmarks.py` cuts 61k → 12k characters for the
  benchmark pass and took it from 5/8 to five runs of 8/8.
- **A failure is invisible.** A thin draft may be a bad report, an unreadable
  PDF, or a model that skipped a table. Nothing on screen distinguishes them.
- **There is nowhere to correct a misreading.** The first thing the editor
  sees is the final per-location price list, long after five reports were
  merged. "The model read 1,560 as 1,650 in the Lube Report table" cannot be
  fixed at that point.

## The shape

**Step 1 — read each file on its own.** One extraction call per file (plus
that file's own image-transcription call, because the USA posted prices
arrive as a picture inside the docx). Each file's findings are shown under
that file's name.

**Step 1 output is as printed.** The location name exactly as the report
writes it, the figure as printed, the currency and unit as printed, the
basis and the assessment date. **No matching to site locations, no FX
conversion, no rules, no midpoints.** Reasons:

- Matching depends on seeing every report at once — a name missing from one
  report is often present in another — and it is where the near-match pairing
  and the lira→USD conversion already live.
- A small mechanical prompt is what a small model does well; it is the whole
  reason the benchmark pass works.
- It makes the review question *"did it read the table right?"*, which is the
  right question to ask of one report, rather than *"is this the right price
  for Korea?"*, which cannot be answered from one report.

**The editor reviews and corrects** each extracted row: change a figure, fix a
name, drop a row, or add one the model missed.

**Step 2 — analyse everything together.** The kept rows from every file go to
the model as one list of evidence, and from there the flow is exactly what it
is today: matching to the site's locations, near-match pairing, the focused
benchmark pass, FX conversion, the rules engine, staging and commit.

## What is stored, and why

Extractions are kept in the database, not in a hidden form field. A two-step
flow whose first step evaporates on a page reload is worse than the one-step
flow it replaces — the point is that four reports can be read, left, and come
back to. It also gives an audit record of what each report actually said,
which is the only way to answer "where did this price come from" later.

`console_extraction_sets` (one per upload session, per site) and
`console_extractions` (one per row the model read). Rows carry the file they
came from and whether the editor kept them.

## Constraints carried over

- Up to **5 files**, each **≤ 10 MB** — unchanged (`MAX_DOCUMENTS`,
  `MAX_DOCUMENT_BYTES`).
- Formats unchanged: docx, xlsx, pdf, txt.
- The module holds no site database credentials; current prices still come
  over the site API.
- Code computes every number the editor acts on. The model proposes and
  narrates; it never does arithmetic that reaches a price.
- The editor's saved per-site instructions ride on both steps.
- Every model call is recorded in `console_ai_usage`. Step 1 introduces two
  new usage kinds: `extract_file` and `extract_file_images`.
- Wording on screen follows the owner's vocabulary rulings: no "derived",
  "benchmark", "rulebook", "extraction". The screen says **read**, **check**,
  **use**.

## Cost

Today: 1 image call + 1 draft call + 1 benchmark call.
After: up to 5 file calls + up to 5 image calls + 1 analysis call + 1
benchmark call. More calls, each far smaller — the token total should be
close to flat, and the accuracy of each call much higher.

## Explicitly not in this change

- The one-step path is not kept as an option. Two screens doing the same job
  differently is what the owner already ruled against for price updates.
- No change to staging, committing, the rules engine, FX, or the site API.
- No change to the crawler, which reads pages rather than uploaded files.
