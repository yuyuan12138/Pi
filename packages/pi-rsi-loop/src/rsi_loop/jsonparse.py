"""Balanced-JSON extraction from LLM output.

Copy-adapted from wave_loop._extract_json (the MC engine's proven parser):
strips code fences, finds the first balanced JSON object, tolerates braces
inside strings, and fails loudly otherwise.
"""
import json
import re


def extract_json_object(text):
    """Extract the first balanced JSON object from raw model output.

    Raises ValueError when no balanced object is present — callers treat that
    as a repairable proposer failure (retry rounds), never as data.
    """
    text = text.strip()
    if text.startswith('```'):
        text = re.sub(r'^```[a-zA-Z]*\n', '', text)
        text = re.sub(r'\n```\s*$', '', text)
    start = text.find('{')
    if start < 0:
        raise ValueError('no JSON object in LLM output')
    depth, in_string, escaped = 0, False, False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == '{':
            depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0:
                return json.loads(text[start:index + 1])
    raise ValueError('no balanced JSON object in LLM output')
