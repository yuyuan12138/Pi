---
name: wps-cloud-sheet
description: Read and write WPS 365 cloud spreadsheets (kdocs.cn links) by driving a dedicated CDP Chrome and calling the in-page WPS Open API. Use when the user shares a kdocs.cn / WPS Docs link, wants their cloud Excel read or analyzed, or asks to record bookkeeping entries into a WPS sheet. Covers the promise-based proxy, the Value=null "null-string" trap, CoreExecTimeout retries, Excel-serial dates, and the persistent-login Chrome profile.
---

# WPS 365 cloud spreadsheet access (CDP + WPS Open API)

Access a WPS 365 cloud sheet without the enterprise-only WPS 365 CLI: drive a
dedicated Chrome via the DevTools Protocol (CDP) and call the page's own
`window.WPSOpenApi`. Works for personal accounts (the CLI requires enterprise).
The tools live in `tools/wps-reader/`.

## Setup (once)
1. `bash tools/wps-reader/launch_chrome.sh "<kdocs link>"` — launches (or reuses)
   a dedicated Chrome on `--remote-debugging-port=9222` with profile
   `~/.chrome-wps-cdp`. That profile keeps the WPS login, so after the first
   sign-in no re-login is needed (the long-term solution).
2. The user signs into WPS in that window (one pause point). If the page shows a
   sign-in wall, tell the user to log in, then continue.

## Reading
- `python3 tools/wps-reader/wps_read.py` — read the currently-open sheet → JSON
  (all sheets, rows as arrays). Options: `--url <link>`, `--sheet <name>`,
  `--csv OUTDIR`, `--max-rows N`.
- The CDP client is embedded in `wps_read.py` (zero deps); import `CDP`,
  `http_json` from it for custom reads.

## Writing (bookkeeping)
- `python3 tools/wps-reader/add_entry.py --amount 25 --category 餐饮 --note 午饭 [--date 2026-11-03]`
  — append one row to 流水-钧 (sheet index 4).
- `python3 tools/wps-reader/batch_add.py entries.json` — append many rows in one
  CDP session. `entries.json` = `[{"date":"YYYY-MM-DD","category":..,"amount":..,"note":..}]`.

## Critical mechanics (learned the hard way)
- **Promise-based proxy**: every `WPSOpenApi` property/method returns a thenable,
  not a value. Wrap each in a native Promise to await it:
  `function P(t){return new Promise(function(r,j){ if(t&&typeof t.then==='function')t.then(r,j); else r(t); });}`
  then `var et=await P(window.WPSOpenApi.EtApplication()); var ws=await P(et.Worksheets); var sh=await P(ws.Item(idx));`.
  Sheet data: `await P(sh.Range(...).Value)` returns a 2-D array of row arrays.
- **`Value=null` writes the literal string `"null"`**, it does not clear the cell.
  To clear, set `Value=''` (empty string). Verify after clearing.
- **Save with `window.WPSOpenApi.save()`**, not `et.Save()` (that throws
  "Save is not a function"). Save persists to the cloud.
- **`CoreExecTimeout: >10000ms` is transient** — the WPS core is busy
  syncing/recalculating. The write often already applied. Wait ~5-8s, re-read the
  cell, and only re-apply if it did not change. Do not assume the write failed.
- **A write timeout followed by "cell not empty: <expected value>" IS success.**
  The value that appears after a timed-out write is exactly what you wrote — never
  re-write it (you would corrupt or duplicate data). Decision rule: on any write
  ambiguity, READ the cell; `value == expected` → success, move on; only re-apply
  when the value differs or is empty.
- **Batch writes: many rows per script invocation, never one bash call per row.**
  One-row-per-call turns a 40-row append into hours of 60s timeouts. One python
  run with per-row try/except + post-write verify handles all rows in minutes.
  Report progress as `n/total` every ~10 rows so the user sees real progress.
- **Dates are Excel serial numbers**: `serial = (date - 1899-12-30).days`
  (e.g. 46023 ≈ 2026-01-01). Write serials to the date column to match existing
  rows; convert on read if you need real dates.
- **Find the real last data row**: `UsedRange.Rows.Count` overstates (includes
  formatted-empty and `'null'`-residue rows). Read the column block and take the
  last row with any non-empty, non-`'null'` cell; append at `last+1`.

## Distinguish real transactions from noise (bookkeeping)
When recording from a WeChat/Alipay bill dump, record only actual money-moved
entries ("Paid by Balance" / "Deducted by Balance"). Skip summary/notification
messages: the daily 记账日报 (yesterday's totals), 微信支付分 "先享后付服务使用通知"
(service notice, no charge). Ask the user to confirm ambiguous categories
(convenience-store purchases default to 零食; a "先购后付" deduction may be a
specific item — ask what it was).

## Verification
Always re-read the written rows back via the Open API and show them to the user
before declaring success. A `save()` without a read-back is not proof the entry
landed. Confirm the sheet title and row count match expectation.