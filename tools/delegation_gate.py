"""Validate declared task ownership; advisory only, not a tool interceptor."""
import argparse

ROUTES = {
    "research": {"subagent", "fork"},
    "implementation": {"subagent", "fork"},
    "testing": {"subagent", "fork"},
    "review": {"subagent"},
    "deployment": {"subagent", "fork"},
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
    parser.add_argument(
        "--fork-context-dependency",
        help="Required when owner=fork: one line stating why the task needs the "
        "live conversation context; without it prefer a clean-context subagent "
        "(fork copies the full primary context into the child).",
    )
    args = parser.parse_args(argv)
    if args.owner == "fork" and not (args.fork_context_dependency or "").strip():
        print(
            "DENY: fork copies the whole primary conversation into the child; "
            "state --fork-context-dependency or use a clean-context subagent"
        )
        return 2
    allowed, message = validate(args.category, args.owner, args.exception)
    print(("ALLOW: " if allowed else "DENY: ") + message)
    return 0 if allowed else 1


if __name__ == "__main__":
    raise SystemExit(main())
