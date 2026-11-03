---
name: visualization-artifacts
description: Generates real visual artifacts (charts, diagrams, structure maps, HTML pages) from real data, with truthful labels and stated limitations. Use when turning data, flows, system structure, or ideas into files a person can actually open.
---

# Skill: visualization artifacts

How to produce real, openable visual files without exaggerating what they prove.

## Pick the form before drawing
- Real measured numbers (metrics, counts, time series, distributions) ->
  chart. matplotlib via `python3 -c` or a one-shot script, output PNG/SVG.
  Use only the libraries already present on the machine; never install.
- Relationships, processes, flows (request paths, lifecycles, state machines)
  -> diagram as inline SVG or a single-file HTML page.
- System or project structure (modules, services, layers) -> architecture map
  (SVG/HTML) built from actually-read files, not memory.
- An idea, plan, or comparison -> sketch-style static HTML or an annotated
  figure; keep prose in the reply short and let the artifact carry the detail.

## Data first, always
- Read the real source before drawing: files named in the brief, or a
  read-only command (`ls`, `grep`, running an existing script). No number on
  a chart may be invented. If a value is estimated, the label must say
  "approx" and the report must repeat that.
- Missing data is drawn as missing (gap, "n/a", labeled blank) and reported
  as a limitation — never interpolated silently.

## Real file, verified
- Write the artifact with `write` or a generation command, then verify it
  exists and is non-trivial: `ls -la` plus file size, and for HTML/SVG that
  the file is well-formed enough to open. A "diagram" that only exists as a
  description in the reply did not happen.
- Default output location: a `visuals/` or `docs/` directory under the
  project root, or the exact path the brief names. Never overwrite an
  existing file.

## Truthful labels
- Every artifact states what it is: a visual explanation, not runtime proof.
  Depicted-from-live-data vs. assumed/expected is marked on the picture
  itself (style or label), not only in the report.
- Preserve the exact mechanism and boundary when simplifying: a friendly
  label may supplement a technical name but must not merge distinct stages,
  states, or owners.
- Single-file HTML (inline CSS/SVG, no CDN) is the safe default; a chart
  library or CDN needs explicit authorization in the brief.

## Red lines
- A chart or diagram is not evidence that code works, is released, or is live.
- No fabricated data points, no invented modules, no "plausible-looking"
  structure that was never read.
- No dependency or chart-library installs; use what is already on the machine
  (python/matplotlib, node, plain HTML/SVG).