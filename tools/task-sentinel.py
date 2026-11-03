#!/usr/bin/env python3
"""Task sentinel: poll registered background tasks, verify completion
contracts, write an append-only ledger and a current-status snapshot,
and send a macOS notification when a task reaches a terminal state.

Design constraints:
- Read-only with respect to task processes (never kills, never writes them).
- Completion is verified by machine-readable fields, never agent claims.
- Single instance guard via an O_EXCL pid file.
- Ledger: ~/.pi/agent/task-ledger/tasks.jsonl (append-only, 0600)
- Snapshot: ~/.pi/agent/task-ledger/current.json (0600, rewritten atomically)
- Registry: ~/.pi/agent/task-ledger/registry.json (managed via CLI)
"""

import json
import os
import re
import subprocess
import sys
import time

LEDGER_DIR = os.path.expanduser('~/.pi/agent/task-ledger')
REGISTRY = os.path.join(LEDGER_DIR, 'registry.json')
LEDGER = os.path.join(LEDGER_DIR, 'tasks.jsonl')
CURRENT = os.path.join(LEDGER_DIR, 'current.json')
PIDFILE = os.path.join(LEDGER_DIR, 'sentinel.pid')

POLL_S = 30
ALLOWED_OPS = {'==true', '==false', '!=null', 'exists', 'file_nonempty'}


def _load_registry():
    if not os.path.exists(REGISTRY):
        return []
    with open(REGISTRY) as f:
        reg = json.load(f)
    if not isinstance(reg, list):
        raise SystemExit('registry.json must be a list')
    return reg


def _save_registry(reg):
    tmp = REGISTRY + '.tmp'
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
        json.dump(reg, f, indent=2, ensure_ascii=False)
    os.replace(tmp, REGISTRY)


def _atomic_write_json(path, obj):
    tmp = path + '.tmp'
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def _ledger_append(entry):
    entry = dict(entry)
    entry['ts'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    with open(os.open(LEDGER, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), 'a') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')


def _notify(title, body):
    # macOS notification; failures are ignored (notifications are best-effort)
    try:
        safe_title = title.replace('"', '')
        safe_body = body.replace('"', '')[:200]
        subprocess.run([
            'osascript', '-e',
            'display notification "%s" with title "%s"' % (safe_body, safe_title)
        ], timeout=10, capture_output=True)
    except Exception:
        pass


def _read_field(obj, dotted):
    cur = obj
    for part in dotted.split('.'):
        if not isinstance(cur, dict) or part not in cur:
            return None, False
        cur = cur[part]
    return cur, True


def _verify(marker_path, verify, proc_alive):
    """Return (state, detail) where state in running/done_ok/done_fail."""
    spec = verify if isinstance(verify, dict) else {}
    op = spec.get('op', 'exists')
    if op not in ALLOWED_OPS:
        op = 'exists'
    field = spec.get('field')
    if not os.path.exists(marker_path):
        # marker absent but process gone => timeout/dead without report
        if not proc_alive:
            return 'done_fail', 'marker_absent_process_gone'
        return 'running', None
    if op == 'exists':
        return 'done_ok', 'marker_present'
    if op == 'file_nonempty':
        try:
            ok = os.path.getsize(marker_path) > 0
        except OSError:
            return 'done_fail', 'marker_unreadable'
        return ('done_ok' if ok else 'running'), 'size'
    try:
        with open(marker_path) as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        if not proc_alive:
            return 'done_fail', 'marker_invalid:' + type(e).__name__
        return 'running', None
    val, found = _read_field(data, field) if field else (None, False)
    if op == '==true':
        ok = found and val is True
    elif op == '==false':
        ok = found and val is False
    elif op == '!=null':
        ok = found and val is not None
    else:
        ok = found
    if ok:
        return 'done_ok', 'verified:' + str(field)
    if not proc_alive:
        return 'done_fail', 'process_gone_unverified:' + str(field)
    return 'running', None


def _proc_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (ValueError, OSError):
        return False


def _match_pattern(pattern):
    import glob
    hits = sorted(glob.glob(os.path.expanduser(pattern)),
                  key=os.path.getmtime, reverse=True)
    return hits[0] if hits else None


def poll_once():
    reg = _load_registry()
    snapshot = []
    for task in reg:
        if not isinstance(task, dict):
            continue
        name = str(task.get('task', 'unnamed'))[:120]
        prev_state = task.get('_state', 'registered')
        if prev_state.startswith('done_') or prev_state == 'timeout':
            snap = {k: v for k, v in task.items() if not k.startswith('_')}
            snap['state'] = prev_state
            snapshot.append(snap)
            continue
        # locate marker
        marker = task.get('markers', {}).get('done', '')
        if not marker:
            state, detail = 'done_fail', 'no_done_marker_declared'
        else:
            if any(c in marker for c in '*?['):
                resolved = _match_pattern(marker)
                if resolved is None:
                    state, detail = ('timeout' if not task.get('_alive', True)
                                     else 'running'), 'no_glob_match'
                    marker = ''
                else:
                    marker = resolved
            if marker:
                alive = True
                pid = task.get('pid')
                if pid:
                    alive = _proc_alive(pid)
                    task['_alive'] = alive
                state, detail = _verify(marker, task.get('verify'), alive)
        # timeout
        started = task.get('_started') or time.time()
        task['_started'] = started
        tmin = task.get('timeout_min') or 0
        if state == 'running' and tmin and (time.time() - started) > tmin * 60:
            state, detail = 'timeout', 'timeout_%dmin' % tmin
        task['_state'] = state
        if detail:
            task['_detail'] = detail
        if state != prev_state and state != 'running':
            _ledger_append({'task': name, 'state': state,
                            'detail': task.get('_detail'), 'marker': marker})
            _notify('Pi task: ' + state, name + ' — ' + str(task.get('_detail', '')))
        snap = {k: v for k, v in task.items() if not k.startswith('_')}
        snap['state'] = state
        snapshot.append(snap)
    _save_registry(reg)
    _atomic_write_json(CURRENT, {'updated': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
                                 'tasks': snapshot})


def cmd_register(args):
    raw = args[0]
    try:
        spec = json.loads(raw)
    except ValueError:
        with open(raw) as f:
            spec = json.load(f)
    if not isinstance(spec, dict) or 'task' not in spec or 'markers' not in spec:
        raise SystemExit('register requires {"task","markers":{done:...}}')
    reg = _load_registry()
    if any(t.get('task') == spec['task'] for t in reg):
        raise SystemExit('task already registered')
    spec.setdefault('timeout_min', 0)
    spec['_state'] = 'registered'
    spec['_started'] = time.time()
    reg.append(spec)
    _save_registry(reg)
    print('registered', spec['task'])


def cmd_status(_args):
    if not os.path.exists(CURRENT):
        print('no snapshot yet')
        return
    data = json.load(open(CURRENT))
    print('updated', data['updated'])
    for t in data['tasks']:
        print('%-12s %-40s %s' % (t.get('state', t.get('_state', '?')),
                                  t.get('task'), t.get('_detail', '')))


def cmd_run(_args):
    os.makedirs(LEDGER_DIR, exist_ok=True)
    try:
        fd = os.open(PIDFILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
    except FileExistsError:
        try:
            old = int(open(PIDFILE).read().strip())
            if _proc_alive(old):
                raise SystemExit('sentinel already running (pid %d)' % old)
            os.unlink(PIDFILE)
            fd = os.open(PIDFILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
        except (ValueError, OSError):
            raise SystemExit('cannot acquire pidfile')
    try:
        while True:
            try:
                poll_once()
            except Exception as e:
                sys.stderr.write('poll error: %r\n' % e)
            time.sleep(POLL_S)
    finally:
        try:
            os.unlink(PIDFILE)
        except OSError:
            pass


def cmd_once(_args):
    poll_once()
    cmd_status([])


def main():
    cmds = {'register': cmd_register, 'status': cmd_status,
            'run': cmd_run, 'once': cmd_once}
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        raise SystemExit('usage: task-sentinel.py register|status|run|once')
    cmds[sys.argv[1]](sys.argv[2:])


if __name__ == '__main__':
    main()
