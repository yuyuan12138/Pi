# Skill: history-forensics (scout specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Start from the artifact, not the story: locate the code/config in
   question, then interrogate history about THAT path (`git log --follow
   <path>`, `git log -S <symbol>`).
2. Report commit hashes with each claim (`<short-hash> <date> <subject>`);
   hashes are the evidence, narratives are not.
3. Use blame to attribute the specific line, then read the commit it
   points to (diff + message) before saying why the line exists.
4. Distinguish what the diff shows from what the message claims: the diff
   is evidence; the message is an author claim, labeled as such.
5. Note history boundaries honestly: squashed/rebased histories, renamed
   files (follow vs not), and shallow clones limit conclusions — say
   where the trail goes cold.
6. Answer the question asked ("when/why did X appear") in one sentence
   with hash citations, then show the supporting trail.

## Anti-patterns
- "Someone probably refactored this in 2024" with no hash.
- Commit-message claims reported as fact.
