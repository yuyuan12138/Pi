"""HTTP proposer transport (OpenAI chat-completions shape).

Copy-adapted from the MC engine's GLMProposer. Generic parts kept here:
bounded bodies, no redirects, retry with non-retryable status short-circuit,
JSON repair rounds, ONLY message.content parsed (reasoning_content is READ
NEVER — never parsed as data, never fed back as instructions), key never
logged. Project parts (endpoint, model, prompts, key source) are constructor
arguments / adapter-supplied.
"""
import http.client
import json
import os
import stat
import time
import urllib.parse
from pathlib import Path

from .errors import ProposerUnavailable
from .jsonparse import extract_json_object

MAX_BODY = 1 << 20
DEFAULT_TIMEOUT_S = 150.0
DEFAULT_RETRIES = 2          # + initial attempt = 3 max
REPAIR_ROUNDS = 3            # 1 initial + 2 JSON repair rounds
NON_RETRYABLE = (400, 401, 403, 404, 422)
MAX_CREDENTIAL_BYTES = 4096
MAX_KEY_CHARS = 256
LOCAL_DUMMY_KEY = 'dummy-local-vllm'   # loopback vLLM accepts any bearer

ENV_BASE_URL = 'RSI_LOOP_PROPOSER_BASE_URL'
ENV_MODEL = 'RSI_LOOP_PROPOSER_MODEL'
ENV_API_KEY = 'RSI_LOOP_PROPOSER_API_KEY'
ENV_MAX_TOKENS = 'RSI_LOOP_PROPOSER_MAX_TOKENS'


def strict_key_loader(path):
    """Optional key loader with the MC-proven security posture: regular file,
    owner-only mode, no symlinks, bounded size, strict JSON, bounded key
    charset. The key is never returned in an error message and never logged.
    (Adapters may instead pass ``api_key=`` directly.)"""
    path = Path(path)
    try:
        fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        raise ProposerUnavailable(
            'proposer API key missing: credentials file not readable (%s)' % path)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_size > MAX_CREDENTIAL_BYTES):
            raise ProposerUnavailable(
                'proposer API key missing: credentials file posture invalid '
                '(mode/owner/size) (%s)' % path)
        with os.fdopen(fd, 'rb') as stream:
            fd = None
            raw = stream.read(MAX_CREDENTIAL_BYTES + 1)
    except ProposerUnavailable:
        raise
    except OSError:
        raise ProposerUnavailable(
            'proposer API key missing: credentials file unreadable (%s)' % path)
    finally:
        if fd is not None:
            os.close(fd)
    try:
        credentials = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        raise ProposerUnavailable('proposer API key missing: credentials not JSON')
    key = credentials.get('api_key') if isinstance(credentials, dict) else None
    if (not isinstance(key, str) or not key or len(key) > MAX_KEY_CHARS
            or any(ord(c) < 33 or ord(c) > 126 for c in key)):
        raise ProposerUnavailable('proposer API key missing: invalid api_key field')
    return key


class HttpProposer:
    """Chat-completions proposer implementing the Proposer port.

    ``messages_builder(ledger, frontier, node, rejections, extra_context)``
    is ADAPTER-supplied (prompts are project content, see ADAPTER.md).
    ``transport(body_bytes, timeout) -> (status, raw_bytes)`` is injectable
    for tests and alternate transports.
    """

    def __init__(self, messages_builder, base_url=None, model=None, api_key=None,
                 credential_path=None, max_tokens=None, timeout=None, retries=None,
                 temperature=0.2, transport=None):
        env = os.environ
        self.messages_builder = messages_builder
        self.model = model or env.get(ENV_MODEL) or 'default'
        self.max_tokens = int(max_tokens or env.get(ENV_MAX_TOKENS) or 8192)
        self.timeout = DEFAULT_TIMEOUT_S if timeout is None else timeout
        self.retries = DEFAULT_RETRIES if retries is None else retries
        self.temperature = temperature
        self.transport = transport
        self._api_key = api_key or env.get(ENV_API_KEY) or None
        self._credential_path = Path(credential_path) if credential_path else None
        url = base_url or env.get(ENV_BASE_URL) or ''
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in ('http', 'https') or not parts.hostname:
            raise ProposerUnavailable('invalid proposer base URL: %r' % url[:200])
        self.scheme = parts.scheme
        self.host = parts.hostname
        self.port = parts.port or (443 if parts.scheme == 'https' else 80)
        base_path = (parts.path or '').rstrip('/')
        self.path = base_path + '/chat/completions' \
            if not base_path.endswith('/chat/completions') else base_path
        self.last_usage = {}
        self.last_headers = None   # tests only; the key is never logged

    def endpoint(self):
        return (self.scheme, self.host, self.port, self.path)

    def _resolved_api_key(self):
        if self._api_key:
            return self._api_key
        if self._credential_path is not None:
            self._api_key = strict_key_loader(self._credential_path)
            return self._api_key
        raise ProposerUnavailable('proposer API key missing: no api_key/credential_path')

    def _headers(self, body_length):
        return {'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + self._resolved_api_key(),
                'Accept': 'application/json',
                'Content-Length': str(body_length)}

    def _http(self, body, timeout):
        if self.transport is not None:
            try:
                self.last_headers = self._headers(len(body))
            except ProposerUnavailable:
                self.last_headers = None      # injected transport: headers unused
            return self.transport(body, timeout)
        headers = self._headers(len(body))    # raises ProposerUnavailable if no key
        self.last_headers = headers
        if self.scheme == 'https':
            conn = http.client.HTTPSConnection(self.host, self.port, timeout=timeout)
        else:
            conn = http.client.HTTPConnection(self.host, self.port, timeout=timeout)
        try:
            conn.request('POST', self.path, body=body, headers=headers)
            resp = conn.getresponse()
            return resp.status, resp.read(MAX_BODY + 1)
        finally:
            try:
                conn.close()
            except OSError:
                pass

    @staticmethod
    def _content(data):
        """Returns message.content, or None for a reasoning-only response
        (reasoning_content is READ NEVER). None is retryable, not fatal."""
        try:
            message = data['choices'][0]['message']
        except (KeyError, IndexError, TypeError):
            return None
        content = message.get('content')
        if not isinstance(content, str) or not content.strip():
            return None
        return content

    def chat(self, messages):
        payload = json.dumps({'model': self.model, 'messages': messages,
                              'temperature': self.temperature,
                              'max_tokens': self.max_tokens,
                              'stream': False}, ensure_ascii=False).encode()
        if len(payload) > MAX_BODY:
            raise ProposerUnavailable('request body exceeds %d bytes' % MAX_BODY)
        if self.transport is None:
            self._resolved_api_key()           # key missing -> fail fast, no retries
        last = None
        for attempt in range(self.retries + 1):
            try:
                status, raw = self._http(payload, self.timeout)
                if status == 200 and len(raw) <= MAX_BODY:
                    data = json.loads(raw.decode('utf-8'))
                    usage = data.get('usage') or {}
                    self.last_usage = {k: usage[k] for k in
                                       ('prompt_tokens', 'completion_tokens', 'total_tokens')
                                       if isinstance(usage.get(k), int)}
                    content = self._content(data)
                    if content is not None:
                        return content
                    last = 'empty_content_no_message_text'   # truncation/refusal: retry
                else:
                    last = 'http_status_%s' % status
                    if status in NON_RETRYABLE:
                        break
            except ProposerUnavailable:
                raise
            except (OSError, http.client.HTTPException, ValueError) as error:
                last = '%s: %s' % (type(error).__name__, str(error)[:120])
            if attempt < self.retries:
                time.sleep(3)
        raise ProposerUnavailable('proposer endpoint failed after %d attempts (%s): %s'
                                  % (self.retries + 1, '%s://%s:%s%s' % self.endpoint(), last))

    def propose(self, ledger, frontier, node, *, rejections=None, raw_sink=None,
                extra_context=None):
        """Proposer port implementation: build messages via the adapter's
        builder, chat, then up to REPAIR_ROUNDS JSON-repair round-trips."""
        messages = self.messages_builder(ledger, frontier, node, rejections,
                                         extra_context)
        last_error = None
        for round_index in range(REPAIR_ROUNDS):
            raw = self.chat(messages)
            if raw_sink is not None:
                raw_sink(round_index, raw)
            try:
                doc = extract_json_object(raw)
                return raw, doc
            except (ValueError, json.JSONDecodeError) as error:
                last_error = error
                messages = messages + [
                    {'role': 'assistant', 'content': raw[:4000]},
                    {'role': 'user', 'content':
                     'That was not valid JSON (%s). Reply again with ONLY the JSON '
                     'object following the schema, no prose, no code fences, '
                     'properly escaped strings.' % error}]
        raise ProposerUnavailable('proposer output not parseable JSON after %d rounds: %s'
                                  % (REPAIR_ROUNDS, last_error))
