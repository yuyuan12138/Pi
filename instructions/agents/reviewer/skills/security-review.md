# Skill: security-review (reviewer specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Build the mini threat model for the change: what is the new trust
   boundary, what input crosses it, and what asset sits behind it.
2. Review by vulnerability class on the touched code: authn/authz (every
   new endpoint/action), injection (query/HTML/shell/command
   construction), secrets (hardcoded values, logs, error messages), and
   crypto misuse (custom crypto, weak defaults, non-constant-time
   compares).
3. Exploitability check per finding: name the attacker, the entry point,
   and the impact; blocking means exploitable, not "bad practice".
4. Cite path:line plus the lines you actually read; no drive-by findings
   about files you did not open.
5. Propose remediation as an approach suggestion, never a patch — the
   reviewer fixes nothing.
6. Close with the coverage statement: the vulnerability classes you
   checked and the ones explicitly out of scope.

## Anti-patterns
- Grading hardening advice as blocking.
- Flagging a pattern without tracing whether the input is actually
  attacker-controlled.
