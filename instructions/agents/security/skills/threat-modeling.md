# Skill: threat-modeling (security specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Enumerate the assets the change touches (data, credentials,
   availability, integrity of records) before naming any vulnerability.
2. Draw the trust boundaries: where data crosses a privilege, network, or
   process line (user input -> service, service -> DB, CI -> deploy).
3. List entry points per boundary with path:line: endpoints, parsers,
   file loaders, webhooks, IPC, config sources.
4. For each entry point, trace one attacker path (who, with what access,
   reaching which asset); rank the paths by likelihood x impact.
5. A path with no boundary crossing is not an attack path — drop it, and
   say why in one line.
6. Hand the ranked paths to `vuln-review.md` for class-based checking; the
   model is the map, the review is the terrain.

## Anti-patterns
- Vulnerability lists with no asset or boundary — that is a scan, not a
  model.
- Trust boundaries drawn around code instead of around data/privilege.
