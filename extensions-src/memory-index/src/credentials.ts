/**
 * Credential-pattern screening applied to every row before it enters the
 * memory index. A row whose content matches any pattern is skipped entirely
 * (counted, never stored) — the index only ever holds distilled observations
 * and knowledge-base entries, and this is the second line of defense behind
 * the "never index raw tool output" scope rule.
 */

export const CREDENTIAL_PATTERNS: { name: string; re: RegExp }[] = [
	{ name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
	{ name: "aws-secret", re: /\b(?=[A-Za-z0-9/+]{40}\b)(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9/+]{40}\b/ },
	{ name: "openai-style-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
	{ name: "github-pat", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
	{ name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
	{ name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/ },
	{ name: "generic-secret-assignment", re: /\b(?:password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*['"]?[^\s'"]{8,}/i },
	{ name: "connection-string-credentials", re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s/:]+:[^\s/@]+@/ },
];

export function matchCredentialPattern(text: string): string | null {
	for (const { name, re } of CREDENTIAL_PATTERNS) {
		if (re.test(text)) return name;
	}
	return null;
}
