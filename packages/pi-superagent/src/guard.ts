/** Commands a worker must never run, even unattended. Fail closed. */
const DENY: Array<[RegExp, string]> = [
  [/\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$)/i, "recursive delete of / or home"],
  [/\bsudo\b/, "sudo"],
  [/\bgit\s+push\b[^\n]*(--force\b|-f\b|--force-with-lease)/, "force push"],
  [/\bgit\s+push\b[^\n]*\b(main|master)\b/, "push to main/master"],
  [/\b(curl|wget)\b[^\n|]*\|\s*(ba|z)?sh\b/, "pipe remote script to shell"],
  [/\bmkfs\b|\bdd\s+if=/, "disk write"],
  [/(~|\$HOME)\/\.(ssh|aws|config\/gh|pi)\b|\bid_rsa\b|\bauth\.json\b|\bmodels\.json\b/, "credential access"],
  [/\bgh\s+(repo\s+delete|secret|auth\s+token)\b/, "dangerous gh command"],
];

export function checkCommand(cmd: string): { ok: true } | { ok: false; reason: string } {
  for (const [re, reason] of DENY) if (re.test(cmd)) return { ok: false, reason };
  return { ok: true };
}
