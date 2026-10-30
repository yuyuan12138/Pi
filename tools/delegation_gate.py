"""Validate declared task ownership; advisory only, not a tool interceptor."""
import argparse

ROUTES = {
    "research": {"fork", "subagent"},
    "implementation": {"fork"},
    "testing": {"fork"},
    "review": {"subagent"},
    "deployment": {"fork"},
    "coordination": {"primary"},
    "trivial": {"primary"},
}
EXCEPTIONS = {
    "unavailable-tools": {"research", "implementation", "testing", "review", "deployment"},
    "integration-only": {"implementation", "testing"},
    "trivial-fix": {"implementation", "testing"},
}


def validate(category, owner, exception=None):
    """Return (allowed, explanation) without inspecting task text or executing work."""
    if category not in ROUTES or owner not in {"primary", "fork", "subagent"}:
        return False, "Unknown category or owner"
    if exception is not None:
        if exception not in EXCEPTIONS:
            return False, "Unknown exception"
        if owner != "primary" or category not in EXCEPTIONS[exception]:
            return False, "Exception does not apply to this category/owner"
        return True, "Primary exception accepted: " + exception
    if owner in ROUTES[category]:
        return True, "Declared ownership matches routing policy"
    return False, "Expected owner: " + ", ".join(sorted(ROUTES[category]))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--category", required=True, choices=sorted(ROUTES))
    parser.add_argument("--owner", required=True, choices=["primary", "fork", "subagent"])
    parser.add_argument("--exception", choices=sorted(EXCEPTIONS))
    args = parser.parse_args(argv)
    allowed, message = validate(args.category, args.owner, args.exception)
    print(("ALLOW: " if allowed else "DENY: ") + message)
    return 0 if allowed else 1


if __name__ == "__main__":
    raise SystemExit(main())
