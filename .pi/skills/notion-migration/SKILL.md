---
name: notion-migration
description: Migrate an Obsidian/Markdown vault into a Notion workspace via the public REST API. Use when converting .md notes to Notion pages (folders, tables, images, frontmatter, wikilinks), fixing table_row HTTP 400 validation errors, doing two-step file uploads, or resuming an interrupted vault migration with per-page checkpoints.
---

# Markdown vault → Notion migration (REST API)

Working pattern from the 2026-11-09 Obsidian→Notion vault migration
(204 notes, 49 folder pages, 114 images; scripts in `/tmp/notion-migration/`:
`md2notion.py` md→blocks, `notion.py` REST client, `migrate.py` runner).

## REST request pattern
- Append content with `PATCH /v1/blocks/{page_id}/children` in **≤100-block
  chunks** (hard API limit), rate-limited to **~3 req/s** (0.36 s gap between
  requests) with 429 backoff. Never log the token.
- **Search before create**: `POST /v1/search` for the vault's top-level page
  title before `POST /v1/pages` — re-running a migration without this creates
  duplicate top-level pages.
- Create pages with `POST /v1/pages` `{"parent": {...}, "properties":
  {"title": {"title": [{"text": {"content": ...}}]}}}`.

## table_row.cells — the one bug that caused every page failure
`table_row.cells` must be **an array of rows, each row an array of rich-text
objects**: `cells: [[{"type": "rich_text", "text": {...}}, ...], ...]`.
Sending a bare rich-text array per row (or unwrapped `"type": "text"` objects)
fails with `HTTP 400 validation_error: ...table.children[0] should be an
object, instead was [{...}]`. All **12 page failures** in the 2026-11-09
migration were this single serialization bug — every page with a table 400'd
on the chunk containing the table. Tables append as: a `table` block
(`table_width`, `has_column_header`, `children: [first table_row block]`)
followed by the remaining `table_row` blocks.

## File uploads are TWO-STEP
1. `POST /v1/file_uploads` (mode/filename metadata) → returns an upload `id`.
2. `POST /v1/file_uploads/{id}/send` with the binary (multipart), then
   reference it in an image block: `{"type": "file_upload",
   "file_upload": {"id": ...}}`.
Notion does **not** auto-fetch external image URLs — remote `![](https://...)`
embeds must be downloaded and sent through the two-step upload.

## Mapping decisions (no Notion equivalent ≠ skip)
- **Frontmatter** → a ⚙️ callout block at the top of the page with the raw
  YAML lines (keep it visible; do not try to map onto Notion page properties).
- **Wikilinks** stay literal `[[title]]` rich text — Notion has no
  vault-wide link graph to resolve them to.
- **`.base` / pdf / excalidraw embeds** have no Notion equivalent — insert a
  placeholder callout (`not migrated`) rather than silently dropping them.

## Checkpointing and repair
- Keep a **per-page checkpoint file** (`progress.json`: path → {notionId,
  status, blocks}) written after each page. On re-run, skip pages with
  `status == "ok"`; pages that exist but are not `ok` were partial → archive
  the partial page (`DELETE /v1/blocks/{id}`) and re-create.
- **Re-parent** an existing page to the workspace root: `PATCH
  /v1/pages/{id}` with `{"parent": {"type": "workspace", "workspace": true}}`.
- **Trash a wrapper page**: `PATCH /v1/pages/{id}` with `{"archived": true}`
  (a plain `DELETE` on the block id does the same).
- Rate-limit posture: failures are per-chunk; a 400 on chunk k leaves chunks
  0..k-1 appended — record the partial state in the checkpoint before retry.
