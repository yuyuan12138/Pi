# Skill: secret-scanning (security specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Scan three surfaces: the working tree (config, scripts, test fixtures,
   docs), git history for the files in scope (secrets live longer in
   history than in files), and the diffs under review (new leaks enter
   through diffs).
2. Hunt credential shapes: API-key/token formats, private-key blocks,
   connection strings with passwords, base64/hex blobs near the words
   key/secret/password/token, tracked .env files.
3. Corroborate before reporting: a shape match is a candidate; read the
   surrounding file to classify real vs example/placeholder (obviously
   fake fixture values are labeled, not alarmed).
4. Report location + type only — NEVER echo the secret value into the
   report, logs, or notes; quote at most a redacted prefix (first few
   characters).
5. For each confirmed secret: flag the rotation need to the parent (a
   deleted secret that was once committed is already exposed) and note
   whether history still contains it.
6. Suggest the preventive fix (gitignore, secret manager, pre-commit
   guard) as a proposal; do not edit files.

## Anti-patterns
- Pasting values "for context".
- Treating rotation as unnecessary because the file was deleted.
