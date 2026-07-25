# Manual test checklist — oversized `.xlsx` Main PI optimisation

**Why this file exists.** The `.xlsx` media optimiser is covered by 58 automated
tests (`src/lib/xlsxMediaOptimizer.test.ts`), but those run under `node --test`
with a **fake image encoder** injected. The real encoder is browser canvas, and
nothing in Node can exercise it. Everything below is therefore a genuine gap in
automated coverage, not a duplicate of it.

Run this checklist logged in, against a database with `20260710` and `20260711`
applied.

> **Never use a confidential production PI in an automated test fixture.** The
> automated suite builds its own synthetic workbooks. The files below are for
> manual runs only, and should not be committed to the repository.

---

## What the automated tests already prove (do not re-do by hand)

| Proven in Node | Where |
| --- | --- |
| Non-media entries byte-identical; sheet names, formula count, relationships intact | tests 6–14 |
| Refusal on invalid ZIP, missing parts, zip bomb, entry-count blowout, path traversal | tests 19–23 |
| A refused workbook never yields uploadable bytes | test 25g |
| `.xls` never routed through the optimiser | test 28 |
| Stale/aborted results discarded | tests 30–33 |

## What ONLY a browser can prove

These depend on `createImageBitmap`, `canvas.toBlob` and real image decoding.

- [ ] **Real size reduction.** A genuine PI over 10 MB is actually brought under
      10 MB — the fake encoder in Node shrinks by construction, so this is the
      first time real compression ratios are observed.
- [ ] **PNG transparency survives.** A workbook with a transparent-background PNG
      logo: after optimisation the logo still has no white box behind it.
- [ ] **Orientation preserved.** A workbook containing a photo with a non-default
      EXIF orientation tag is not rotated by the round trip.
- [ ] **No upscaling.** A small-but-heavy image keeps its pixel dimensions.
- [ ] **WEBP stays WEBP** (or is left untouched if the browser cannot encode it) —
      never silently rewritten as PNG/JPEG.
- [ ] **Visual fidelity.** Open the optimised workbook in Excel and confirm logos,
      stamps and product photos are still legible at print size.

## Workbook fixtures to try

Each should be tested **just above 10 MB** and **far above 10 MB** where practical.

- [ ] formulas across multiple sheets
- [ ] merged cells
- [ ] company logo (PNG, with transparency)
- [ ] product photographs (JPEG, large)
- [ ] charts
- [ ] cell comments
- [ ] conditional formatting
- [ ] data validation dropdowns
- [ ] print settings / print area / page setup
- [ ] hyperlinks (internal and external)
- [ ] unsupported media (EMF/WMF/SVG/GIF) alongside supported images
- [ ] a workbook whose bulk is NOT images (refusal expected)
- [ ] a deliberately malformed / truncated `.xlsx` (refusal expected)
- [ ] a password-protected workbook (refusal expected — it is not a readable ZIP)
- [ ] `.xls` under 10 MB (accepted unchanged) and over 10 MB (refused)

**After each accepted optimisation, open the file in Excel and confirm:** it opens
with no repair prompt, every sheet is present, formulas still calculate, charts
and drawings render, print setup is unchanged, and hyperlinks still work.

An "Excel offered to repair this file" prompt is a **hard failure** — the
validation gate should have refused that workbook rather than accepting it.

## UI states to observe

- [ ] Labels advance through **Reading workbook… → Optimizing embedded images… →
      Rebuilding workbook… → Validating workbook… → Ready to upload**.
- [ ] The **Submit button stays disabled** for the whole processing run.
- [ ] The row shows **original size → optimised size**.
- [ ] Replacing the file mid-optimisation: the earlier result never lands on the
      new selection.
- [ ] Closing the modal mid-optimisation leaves no stale state and no upload.
- [ ] A refusal shows the honest message and offers **no** way to upload the
      original oversized file.
- [ ] The tab stays responsive on a 40 MB workbook (the ZIP work is off the main
      thread; confirm no visible freeze).
- [ ] No percentage progress appears anywhere.
