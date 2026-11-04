#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pi_dashboard.py — 从 Pi 会话 JSONL 生成单文件活动仪表盘（仅 Python 标准库）。

用法:
  python3 pi_dashboard.py --session <path|latest> [--subagents-dir DIR]
                         [--out /tmp/pi-dashboard.html] [--last-n 400]
                         [--subagents-all]

视图: KPI(+诊断徽章) / Token流 / 每轮上下文构成(字符比例估算) / 工具调用 /
     诊断明细 / 子代理 / 模型 / 事件密度；全部包裹在可折叠 <details> 中，
     顶部有粘性锚点导航。

所有数字均由会话文件计算得出；字段缺失时显示 n/a 而不是 0。
估算值（如上下文构成）明确标注「估算」。

增量解析: 旁路缓存 <session-file>.dashcache.json（mtime/size/offset/前缀哈希/
紧凑事件记录）。文件未变 → 直接用缓存；文件增长(append-only) → 校验前缀哈希后
只解析新增字节；缩小/替换/损坏 → 全量重解析。缓存任何失败都静默退回全量解析。
"""

import argparse
import glob
import hashlib
import html
import json
import math
import os
import re
import statistics
import sys
import time
from datetime import datetime, timezone

DEFAULT_SUBAGENTS_DIR = "/Users/yuyuan/PiAgents/.pi/subagents"
DEFAULT_SESSIONS_ROOT = os.path.expanduser("~/.pi/agent/sessions")

REPORT_RE = re.compile(r"^\[subagent\s+([^\]·]+?)\s*·\s*([^\]]+?)\]\s*([^:\s]+)\s*:")

CACHE_VERSION = 2
CACHE_MAX_BYTES = 50 * 1024 * 1024  # 超过则放弃写缓存（健全性上限）

# ---------------------------------------------------------------- helpers ---

def esc(s):
    return html.escape(str(s), quote=True)


def parse_ts(s):
    """ISO 时间戳 -> epoch 秒 (UTC)；失败返回 None。"""
    if not s or not isinstance(s, str):
        return None
    t = s.strip()
    if t.endswith("Z"):
        t = t[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(t)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def fmt_clock(e, with_day=False):
    if e is None:
        return "n/a"
    dt = datetime.fromtimestamp(e, tz=timezone.utc)
    return dt.strftime("%m-%d %H:%M:%S") if with_day else dt.strftime("%H:%M:%S")


def fmt_hm(e):
    if e is None:
        return "n/a"
    return datetime.fromtimestamp(e, tz=timezone.utc).strftime("%H:%M")


def fmt_day(e):
    if e is None:
        return "n/a"
    return datetime.fromtimestamp(e, tz=timezone.utc).strftime("%m-%d %H:%M")


def human_num(v):
    if v is None:
        return "n/a"
    a = abs(v)
    if a >= 1e9:
        return f"{v / 1e9:.2f}B"
    if a >= 1e6:
        return f"{v / 1e6:.2f}M"
    if a >= 1e3:
        return f"{v / 1e3:.1f}k"
    return f"{v}"


def human_bytes(v):
    if v is None:
        return "n/a"
    if v >= 1 << 20:
        return f"{v / (1 << 20):.1f}MB"
    if v >= 1 << 10:
        return f"{v / (1 << 10):.1f}KB"
    return f"{v}B"


def human_dur(ms):
    if ms is None:
        return "n/a"
    if ms < 1000:
        return f"{ms:.0f}ms"
    if ms < 60000:
        return f"{ms / 1000:.1f}s"
    return f"{ms / 60000:.1f}min"


def fmt_span_secs(sec):
    if sec is None:
        return "n/a"
    sec = int(sec)
    if sec >= 3600:
        return f"{sec // 3600}h{(sec % 3600) // 60:02d}m"
    if sec >= 60:
        return f"{sec // 60}m{sec % 60:02d}s"
    return f"{sec}s"


def trunc(s, n=60):
    s = str(s).replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


def sha256_prefix(path, nbytes):
    """文件前 nbytes 字节的 sha256（增量缓存的完整性校验）。"""
    h = hashlib.sha256()
    remain = max(0, int(nbytes))
    with open(path, "rb") as f:
        while remain > 0:
            chunk = f.read(min(1 << 20, remain))
            if not chunk:
                break
            h.update(chunk)
            remain -= len(chunk)
    return h.hexdigest()


# ----------------------------------------------------------------- parsing ---

def resolve_session(spec):
    if spec != "latest":
        p = os.path.expanduser(spec)
        if not os.path.isfile(p):
            raise SystemExit(f"错误: 会话文件不存在: {p}")
        return p
    cands = glob.glob(os.path.join(DEFAULT_SESSIONS_ROOT, "**", "*.jsonl"), recursive=True)
    if not cands:
        raise SystemExit(f"错误: {DEFAULT_SESSIONS_ROOT} 下未找到 *.jsonl 会话文件")
    return max(cands, key=os.path.getmtime)


def arg_sample(args):
    """从工具调用参数里取一个可读样本。"""
    if isinstance(args, dict):
        for k in ("path", "command", "file_path", "pattern", "url", "query", "prompt", "session"):
            if k in args and args[k] not in (None, ""):
                return trunc(args[k], 60)
        try:
            return trunc(json.dumps(args, ensure_ascii=False), 60)
        except Exception:
            return trunc(args, 60)
    if args in (None, ""):
        return None
    return trunc(args, 60)


def text_len_of(content):
    """消息内容的纯文本字符数（只计 type:text 片段；字符串内容直接计长）。"""
    n = 0
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        for c in content:
            if isinstance(c, dict) and c.get("type") == "text" and isinstance(c.get("text"), str):
                n += len(c["text"])
    return n


def count_lines(path):
    size = os.path.getsize(path)
    if size == 0:
        return 0
    n = 0
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            n += chunk.count(b"\n")
    # 最后一行若无换行符也计入
    with open(path, "rb") as f:
        f.seek(size - 1)
        if f.read(1) != b"\n":
            n += 1
    return n


def last_event_type(path, tail=4096):
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            f.seek(max(0, size - tail))
            blob = f.read().decode("utf-8", "replace")
        for line in reversed([x for x in blob.splitlines() if x.strip()]):
            try:
                o = json.loads(line)
                t = o.get("type")
                if t:
                    return str(t)
            except Exception:
                continue
    except OSError:
        pass
    return None


def file_span(path):
    """文件时间跨度（birth→mtime，UTC epoch 对），events.jsonl 无时间戳时的诚实替代。"""
    try:
        st = os.stat(path)
    except OSError:
        return None
    b = getattr(st, "st_birthtime", None) or st.st_ctime
    return (b, st.st_mtime)


# ------------------------------------------------------- 紧凑事件 + 缓存 ---

def encode_event(o, ts):
    """原始 JSONL 行 -> 紧凑事件记录（缓存友好；只保留各视图需要的字段）。"""
    t = o.get("type")
    if t == "session":
        return {"y": "s", "ts": ts,
                **{k: o[k] for k in ("cwd", "id", "version") if o.get(k) is not None}}
    if t == "compaction":
        summ = o.get("summary")
        tb = o.get("tokensBefore")
        return {"y": "c", "ts": ts,
                "sl": len(summ) if isinstance(summ, str) else 0,
                "tb": tb if isinstance(tb, (int, float)) else None}
    if t == "context_edit":
        return {"y": "ce", "ts": ts}
    if t == "model_change":
        return {"y": "mc", "ts": ts, "m": o.get("modelId") or o.get("model") or "n/a"}
    if t == "custom":
        return {"y": "cu", "ts": ts, "ct": o.get("customType") or o.get("name") or "unknown"}
    if t == "custom_message":
        if (o.get("customType") or "") != "subagent-report":
            return {"y": "o", "ts": ts, "t": str(t)}
        content = o.get("content") or ""
        m = REPORT_RE.match(content)
        return {"y": "sr", "ts": ts,
                "id": m.group(1).strip() if m else None,
                "lb": m.group(2).strip() if m else None,
                "st": m.group(3) if m else None,
                "ch": len(content)}
    if t == "message":
        m = o.get("message")
        if not isinstance(m, dict):
            return {"y": "o", "ts": ts, "t": str(t)}
        role = m.get("role") or "unknown"
        content = m.get("content")
        if role == "assistant":
            calls = []
            first_tool = None
            has_text = False
            tlen = 0
            for c in (content if isinstance(content, list) else []):
                if not isinstance(c, dict):
                    continue
                ct = c.get("type")
                if ct == "toolCall":
                    name = c.get("name") or "n/a"
                    args = c.get("arguments")
                    try:
                        aj = json.dumps(args, sort_keys=True, ensure_ascii=False,
                                        separators=(",", ":"))
                    except Exception:
                        aj = str(args)
                    nh = hashlib.sha256(aj.encode("utf-8")).hexdigest()[:16]
                    calls.append([name, c.get("id"), arg_sample(args), nh])
                    if first_tool is None:
                        first_tool = name
                elif ct == "text":
                    has_text = True
                    if isinstance(c.get("text"), str):
                        tlen += len(c["text"])
            u = m.get("usage") if isinstance(m.get("usage"), dict) else {}

            def _un(key):
                v = u.get(key)
                return v if isinstance(v, (int, float)) else None

            cost = u.get("cost")
            return {"y": "a", "ts": ts, "mo": m.get("model"), "pv": m.get("provider"),
                    "du": m.get("durationMs") if isinstance(m.get("durationMs"), (int, float)) else None,
                    "u": [_un("input"), _un("output"), _un("cacheRead"),
                          _un("cacheWrite"), _un("reasoning"), _un("totalTokens")],
                    "cst": (cost.get("total")
                            if isinstance(cost, dict) and isinstance(cost.get("total"), (int, float))
                            else None),
                    "cl": calls, "ht": has_text, "ft": first_tool, "tl": tlen}
        if role == "toolResult":
            dur = m.get("durationMs")
            return {"y": "tr", "ts": ts, "cid": m.get("toolCallId"),
                    "nm": m.get("toolName") or "n/a", "er": bool(m.get("isError")),
                    "du": dur if isinstance(dur, (int, float)) else None,
                    "tl": text_len_of(content)}
        # user / system / 其他角色
        return {"y": "m", "ts": ts, "r": role, "tl": text_len_of(content)}
    return {"y": "o", "ts": ts, "t": t if isinstance(t, str) else "unknown"}


def read_events_from(path, offset=0):
    """从字节 offset 起按行解析；返回 (events, complete_offset, n_lines, skipped)。

    complete_offset = 最后一个以 \n 结尾的完整行之后的字节位置。文件末尾不完整
    的行（live append 进行中）推迟到下一次解析，避免增量缓存重复计入同一行。
    """
    events = []
    n_lines = 0
    skipped = 0
    pos = offset
    with open(path, "rb") as f:
        if offset:
            f.seek(offset)
        while True:
            raw = f.readline()
            if not raw:
                break
            n_lines += 1
            if not raw.endswith(b"\n"):
                break  # 不完整尾行：本轮不计入 events，下次从头解析该行
            pos += len(raw)
            s = raw.decode("utf-8", "replace").strip()
            if not s:
                continue
            try:
                o = json.loads(s)
            except Exception:
                skipped += 1
                continue
            if not isinstance(o, dict):
                skipped += 1
                continue
            events.append(encode_event(o, parse_ts(o.get("timestamp"))))
    return events, pos, n_lines, skipped


def load_events(path):
    """带旁路缓存的事件加载。返回 (events, pinfo)。

    pinfo: {mode: full|incr|cache, secs, lines, skipped, offset, prefix_sha}
    缓存失效/损坏一律静默退回全量解析。
    """
    t0 = time.time()
    st = os.stat(path)
    cache = None
    try:
        with open(path + ".dashcache.json", "r", encoding="utf-8") as f:
            c = json.load(f)
        if (isinstance(c, dict) and c.get("v") == CACHE_VERSION
                and isinstance(c.get("events"), list)
                and isinstance(c.get("offset"), int)):
            cache = c
    except Exception:
        cache = None

    if cache is not None:
        co = cache["offset"]
        cm, cs = cache.get("mtime"), cache.get("size")
        # 1) mtime+size 未变且缓存覆盖到文件尾 -> 完全跳过解析
        if (isinstance(cm, (int, float)) and isinstance(cs, int)
                and co == cs == st.st_size and cm == st.st_mtime):
            head = sha256_prefix(path, min(256, st.st_size))
            if cache.get("head_sha") == head:
                return cache["events"], {
                    "mode": "cache", "secs": time.time() - t0,
                    "lines": cache.get("nl", len(cache["events"])),
                    "skipped": cache.get("sk", 0), "offset": co,
                    "prefix_sha": cache.get("prefix_sha")}
        # 2) 文件增长（append-only）：校验前缀哈希后只解析新增字节
        if (st.st_size > co and cache.get("prefix_sha")
                and sha256_prefix(path, co) == cache["prefix_sha"]):
            nev, pos, nl, sk = read_events_from(path, co)
            events = cache["events"] + nev
            cached_nl = cache.get("nl", 0)
            return events, {
                "mode": "incr", "secs": time.time() - t0,
                "lines": cached_nl + nl, "added": nl, "cached_lines": cached_nl,
                "skipped": cache.get("sk", 0) + sk,
                "offset": pos, "prefix_sha": cache["prefix_sha"]}
        # 3) 其他情况（缩小/替换/校验失败）-> 全量
    events, pos, nl, sk = read_events_from(path, 0)
    return events, {"mode": "full", "secs": time.time() - t0,
                    "lines": nl, "added": nl, "skipped": sk,
                    "offset": pos, "prefix_sha": None}


def save_cache(path, events, pinfo, calibration):
    """写旁路缓存；任何失败静默放弃（返回 False）。超过 CACHE_MAX_BYTES 不写。"""
    try:
        st = os.stat(path)
        prefix_sha = pinfo.get("prefix_sha") or sha256_prefix(path, pinfo["offset"])
        payload = {
            "v": CACHE_VERSION, "mtime": st.st_mtime, "size": st.st_size,
            "offset": pinfo["offset"], "nl": pinfo["lines"], "sk": pinfo["skipped"],
            "prefix_sha": prefix_sha,
            "head_sha": sha256_prefix(path, min(256, st.st_size)),
            "calibration": calibration, "events": events,
        }
        blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(blob) > CACHE_MAX_BYTES:
            return False
        tmp = path + ".dashcache.json.tmp"
        with open(tmp, "wb") as f:
            f.write(blob)
        os.replace(tmp, path + ".dashcache.json")
        return True
    except Exception:
        return False


# ------------------------------------------------- 会话聚合（含上下文构成） ---

def build_session(events, path, n_lines, skipped):
    d = {
        "path": path,
        "size": os.path.getsize(path) if os.path.exists(path) else None,
        "n_lines": n_lines,
        "skipped": skipped,
        "parsed": len(events),
        "meta": {},
        "t_first": None,
        "t_last": None,
        "roles": {},
        "usage": {k: [0, 0] for k in ("input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens")},
        "cost_total": [0.0, 0],
        "assistant": [],
        "turns": [],                       # 每条 assistant 消息的上下文构成估算
        "tool_calls": [],                  # (ts, name, id, sample, normhash)
        "tool_results": [],                # (ts, id, name, isError, durationMs)
        "tool_err_dur": {},
        "tool_args": {},
        "sub_reports": [],
        "spawn_ts": [],
        "compactions": 0,
        "compaction_ts": [],
        "context_edits": 0,
        "model_changes": 0,
        "model_change_ts": [],
        "om": {},
        "ribbon": [],
    }
    usage = d["usage"]
    sys_chars = 0        # system 消息文本累计（会话文件通常不含系统提示）
    hist_chars = 0       # 历史消息文本累计（旧 user/assistant/toolResult 文本）
    turn_user = 0        # 本轮用户输入文本（自上一条 assistant 消息以来）
    turn_tool = 0        # 本轮收到的工具结果文本（自上一条 assistant 消息以来）
    mc_pending = False   # 自上一条 assistant 消息以来发生过 model_change
    comp_pending = []    # 同上窗口内的 compaction (ts, tokensBefore)

    for ev in events:
        y = ev.get("y")
        ts = ev.get("ts")
        if ts is not None:
            if d["t_first"] is None or ts < d["t_first"]:
                d["t_first"] = ts
            if d["t_last"] is None or ts > d["t_last"]:
                d["t_last"] = ts
        if y == "s":
            d["meta"] = {k: ev[k] for k in ("cwd", "id", "version") if ev.get(k) is not None}
        elif y == "c":
            d["compactions"] += 1
            d["compaction_ts"].append(ev.get("ts"))
            d["ribbon"].append((ev.get("ts"), "compaction"))
            comp_pending.append((ev.get("ts"), ev.get("tb")))
            # 压缩：历史被摘要替换 -> 历史字符重置为摘要长度，本轮缓冲清零
            hist_chars = ev.get("sl") or 0
            turn_tool = 0
            turn_user = 0
        elif y == "ce":
            d["context_edits"] += 1
        elif y == "mc":
            d["model_changes"] += 1
            d["model_change_ts"].append(ev.get("ts"))
            mc_pending = True
        elif y == "cu":
            ct = ev.get("ct") or "unknown"
            d["om"][ct] = d["om"].get(ct, 0) + 1
        elif y == "sr":
            d["sub_reports"].append({
                "ts": ev.get("ts"), "id": ev.get("id"), "label": ev.get("lb"),
                "status": ev.get("st"), "chars": ev.get("ch") or 0})
        elif y == "a":
            d["roles"]["assistant"] = d["roles"].get("assistant", 0) + 1
            u = {}
            for key, v in zip(("input", "output", "cacheRead", "cacheWrite",
                               "reasoning", "totalTokens"), ev.get("u") or []):
                if isinstance(v, (int, float)):
                    usage[key][0] += v
                    usage[key][1] += 1
                    u[key] = v
            if isinstance(ev.get("cst"), (int, float)):
                d["cost_total"][0] += ev["cst"]
                d["cost_total"][1] += 1
            first_tool = ev.get("ft")
            for name, cid, sample, nh in (ev.get("cl") or []):
                d["tool_calls"].append((ts, name, cid, sample, nh))
                d["tool_args"].setdefault(name, [])
                if len(d["tool_args"][name]) < 3 and sample is not None:
                    d["tool_args"][name].append(sample)
                if name in ("subagent_spawn", "subagent") and ts is not None:
                    d["spawn_ts"].append((ts, name))
            tlen = ev.get("tl") or 0
            d["assistant"].append({
                "ts": ts, "model": ev.get("mo"), "provider": ev.get("pv"),
                "durationMs": ev.get("du"), "usage": u,
                "first_tool": first_tool, "has_text": bool(ev.get("ht")),
                "n_calls": len(ev.get("cl") or [])})
            # —— 每轮上下文构成（估算）：分配后把本轮文本折入历史 ——
            d["turns"].append({
                "ts": ts, "model": ev.get("mo"),
                "ctx": [u.get("input"), u.get("cacheRead"), u.get("cacheWrite")],
                "chars": {"sys": sys_chars, "tools": turn_tool,
                          "hist": hist_chars, "user": turn_user},
                "comp_before": comp_pending, "mc_before": mc_pending})
            comp_pending = []
            mc_pending = False
            hist_chars += turn_tool + turn_user + tlen
            turn_tool = 0
            turn_user = 0
            if ts is not None:
                d["ribbon"].append((ts, "assistant"))
        elif y == "tr":
            name = ev.get("nm") or "n/a"
            err = bool(ev.get("er"))
            d["roles"]["toolResult"] = d["roles"].get("toolResult", 0) + 1
            d["tool_results"].append((ts, ev.get("cid"), name, err, ev.get("du")))
            turn_tool += ev.get("tl") or 0
            agg = d["tool_err_dur"].setdefault(name, [0, 0.0, 0])
            if err:
                agg[0] += 1
            if isinstance(ev.get("du"), (int, float)):
                agg[1] += ev["du"]
                agg[2] += 1
            if ts is not None:
                d["ribbon"].append((ts, "toolResult"))
        elif y == "m":
            role = ev.get("r") or "unknown"
            d["roles"][role] = d["roles"].get(role, 0) + 1
            if role == "user":
                turn_user += ev.get("tl") or 0
            elif role == "system":
                sys_chars += ev.get("tl") or 0
            if ts is not None and role in ("user", "system"):
                d["ribbon"].append((ts, role))
        # y == "o": 不影响任何视图
    return d


# ------------------------------------------------------------ 诊断徽章 ---

def analyze_diagnostics(d):
    """重复调用 / 连续失败 / 打转（均为启发式，详见 HTML 内说明）。"""
    groups = {}
    for ts, name, _cid, _sample, nh in d["tool_calls"]:
        g = groups.setdefault((name, nh), {"name": name, "n": 0, "ts": []})
        g["n"] += 1
        if ts is not None:
            g["ts"].append(ts)
    repeats = []
    for g in groups.values():
        if g["n"] < 3:
            continue
        tss = sorted(g["ts"])
        win_max, win_s, win_e = 0, None, None
        j = 0
        for i in range(len(tss)):
            while tss[i] - tss[j] > 600:
                j += 1
            if i - j + 1 > win_max:
                win_max, win_s, win_e = i - j + 1, tss[j], tss[i]
        repeats.append({"name": g["name"], "n": g["n"],
                        "first": tss[0] if tss else None,
                        "last": tss[-1] if tss else None,
                        "win_max": win_max, "win_start": win_s, "win_end": win_e})
    repeats.sort(key=lambda r: (-r["n"], r["name"]))
    spin = sorted((r for r in repeats if r["win_max"] >= 3),
                  key=lambda r: (-r["win_max"], r["name"]))

    # 全局连续错误 streak（按 toolResult 文件顺序）
    best, cur, best_len = None, None, 0
    for idx, (ts, _cid, name, err, _dur) in enumerate(d["tool_results"]):
        if err:
            if cur is None:
                cur = {"start_idx": idx, "end_idx": idx, "start": ts, "end": ts,
                       "n": 1, "tools": {name: 1}}
            else:
                cur["end_idx"] = idx
                cur["end"] = ts
                cur["n"] += 1
                cur["tools"][name] = cur["tools"].get(name, 0) + 1
            if cur["n"] > best_len:
                best_len = cur["n"]
                best = dict(cur)
        else:
            cur = None
    recovery = None
    if best:
        for i in range(best["end_idx"] + 1, len(d["tool_results"])):
            if not d["tool_results"][i][3]:
                if best["start"] is not None and d["tool_results"][i][0] is not None:
                    recovery = d["tool_results"][i][0] - best["start"]
                break
    d["diag"] = {"repeats": repeats, "spin": spin, "streak": best, "recovery": recovery}
    return d["diag"]


def fit_calibration(d):
    """全局字符→token 校准系数 R = median(轮前累计字符 / 该轮上下文 tokens)。

    校准目标 = usage.input + cacheRead + cacheWrite（即完整提示）。
    仅用 usage.input 会在缓存/非缓存端点混用时严重失真（见 README 报告）。
    """
    ratios = []
    for t in d["turns"]:
        ctx = sum(v for v in t["ctx"] if isinstance(v, (int, float)))
        ch = t["chars"]
        tot = ch["sys"] + ch["tools"] + ch["hist"] + ch["user"]
        if ctx > 0 and tot > 0:
            ratios.append(tot / ctx)
    usable = len(ratios)
    r = statistics.median(ratios) if usable >= 10 else None
    if r is not None and r <= 0:
        r = None
    d["calibration"] = {"R": r, "turns_used": usable,
                        "target": "usage.input+cacheRead+cacheWrite"}
    return d["calibration"]


# ------------------------------------------------------ subagent disk scan ---

def scan_subagents(sub_dir, session, all_mode):
    """返回按报告合并后的卡片数据列表。"""
    win0, win1 = session["t_first"], session["t_last"]
    referenced = {r["id"] for r in session["sub_reports"] if r["id"]}
    reports = {}
    for r in session["sub_reports"]:
        key = r["id"] or f"__noreport{r['ts']}"
        e = reports.setdefault(key, {"id": r["id"], "label": None, "events_r": []})
        if e["label"] is None and r["label"]:
            e["label"] = r["label"]
        e["events_r"].append(r)

    dirs = []
    if os.path.isdir(sub_dir):
        dirs = sorted(x for x in os.listdir(sub_dir)
                      if os.path.isdir(os.path.join(sub_dir, x)))
    cards = []
    seen_keys = set()
    for name in dirs:
        p = os.path.join(sub_dir, name)
        ev = os.path.join(p, "events.jsonl")
        res = os.path.join(p, "result.md")
        tr = os.path.join(p, "transcript.log")
        mtimes = [os.path.getmtime(x) for x in (ev, res, tr) if os.path.exists(x)]
        latest_mt = max(mtimes) if mtimes else os.path.getmtime(p)
        in_win = win0 is not None and win1 is not None and win0 <= latest_mt <= win1
        ref = name in referenced
        if not all_mode and not (in_win or ref):
            continue
        rep = reports.get(name)
        card = {
            "id": name,
            "label": (rep or {}).get("label"),
            "reports": (rep or {}).get("events_r", []),
            "in_report": rep is not None,
            "n_events": count_lines(ev) if os.path.isfile(ev) else None,
            "span": file_span(ev) if os.path.isfile(ev) else None,
            "result_size": os.path.getsize(res) if os.path.isfile(res) else None,
            "transcript_size": os.path.getsize(tr) if os.path.isfile(tr) else None,
            "last_event": last_event_type(ev) if os.path.isfile(ev) else None,
            "in_window": in_win,
        }
        cards.append(card)
        seen_keys.add(name)
    # 报告里出现但磁盘上没有目录的 id
    for key, rep in reports.items():
        if key in seen_keys or key.startswith("__noreport"):
            continue
        cards.append({
            "id": rep.get("id") or key, "label": rep.get("label"), "reports": rep["events_r"],
            "in_report": True, "n_events": None, "span": None, "result_size": None,
            "transcript_size": None, "last_event": None, "in_window": False,
        })

    def sort_key(c):
        rts = min((r["ts"] for r in c["reports"] if r["ts"] is not None), default=None)
        return (0 if c["in_report"] else 1, rts if rts is not None else float("inf"), c["id"])

    cards.sort(key=sort_key)
    return cards


# ------------------------------------------------------------ SVG builders ---

SEG_ORDER = (("input", "#4c8dff", "输入"), ("cacheRead", "#2fb9c9", "缓存读"),
             ("output", "#f5a63b", "输出"), ("reasoning", "#e5534b", "推理"))

RIBBON_COLORS = (("user", "#4c8dff", "用户"), ("assistant", "#3fbf7f", "助手"),
                 ("toolResult", "#39424f", "工具结果"), ("compaction", "#ff5d73", "压缩"))

# 每轮上下文构成的段（自下而上堆叠顺序）
CTX_SEGS = (("sys", "#8b5cf6", "系统提示"), ("tools", "#14b8a6", "工具结果"),
            ("hist", "#3b82f6", "历史消息"), ("user", "#f59e0b", "本轮输入"))
CTX_COMPACT_COLOR = "#ff5d73"
CTX_MC_COLOR = "#3fbf7f"


def svg_token_flow(amsgs, win_note):
    n = len(amsgs)
    if n == 0:
        return '<p class="na">n/a（窗口内没有 assistant 消息）</p>', None, None
    W, H = 720, 250
    px0, px1 = 6.0, W - 6.0
    top, bot = 40.0, H - 26.0
    ph = bot - top

    totals = []
    for m in amsgs:
        u = m["usage"]
        totals.append(sum(u.get(k) or 0 for k in ("input", "cacheRead", "output", "reasoning")))
    maxt = max(totals)
    if maxt <= 0:
        return '<p class="na">n/a（窗口内 assistant 消息均无 usage 数据）</p>', None, None
    nonzero = [t for t in totals if t > 0]
    mint = min(nonzero)
    ratio = maxt / mint if mint > 0 else 1.0
    sqrt_mode = ratio > 100
    denom = math.sqrt(maxt) if sqrt_mode else float(maxt)
    ratio_txt = f"{ratio:,.0f}" if ratio >= 10 else f"{ratio:.1f}"
    scale_note = f"√ 比例（最大/最小 {ratio_txt}×）" if sqrt_mode else "线性比例"

    bw = (px1 - px0) / n
    w = min(max(bw - 0.7, 0.7), 42.0)
    parts = []
    for i, m in enumerate(amsgs):
        u = m["usage"]
        tot = totals[i]
        x = px0 + i * bw + (max(bw - w, 0) / 2 if bw > 48 else 0)
        cum_prev = 0.0
        cum_h = 0.0
        segs = []
        for key, color, _zh in SEG_ORDER:
            v = u.get(key)
            if not isinstance(v, (int, float)) or v <= 0:
                continue
            base = cum_h
            if sqrt_mode:
                cum_h += (math.sqrt(cum_prev + v) - math.sqrt(cum_prev)) / denom * ph
            else:
                cum_h += v / denom * ph
            cum_prev += v
            if cum_h - base < 0.03:
                continue
            segs.append(f'<rect x="{x:.2f}" y="{bot - cum_h:.2f}" width="{w:.2f}" '
                        f'height="{cum_h - base:.2f}" fill="{color}"/>')
        if not segs:
            continue
        tip = (f"{fmt_clock(m['ts'], with_day=True)} · {esc(m['model'] or 'n/a')}\n"
               f"输入 {human_num(u.get('input'))} · 缓存读 {human_num(u.get('cacheRead'))} · "
               f"输出 {human_num(u.get('output'))} · 推理 {human_num(u.get('reasoning'))}")
        parts.append(f'<g><title>{esc(tip)}</title>{"".join(segs)}</g>')

    # top-5 标注
    top_idx = sorted(range(n), key=lambda i: totals[i], reverse=True)[:5]
    rows = [top - 10, top - 24]
    last_x = [-1e9, -1e9]
    for i in sorted(top_idx, key=lambda i: i):
        if totals[i] <= 0:
            continue
        m = amsgs[i]
        label = m["first_tool"] or ("text" if m["has_text"] else "n/a")
        cx = px0 + i * bw + bw / 2
        row = 0 if cx - last_x[0] > 60 else 1
        ry = rows[row]
        last_x[row] = cx
        bar_top = bot - (math.sqrt(totals[i]) / denom * ph if sqrt_mode else totals[i] / denom * ph)
        parts.append(f'<line x1="{cx:.1f}" y1="{ry + 3:.1f}" x2="{cx:.1f}" y2="{bar_top - 2:.1f}" '
                     f'stroke="#8b96a8" stroke-width="0.6" stroke-dasharray="2 2"/>')
        parts.append(f'<text x="{cx:.1f}" y="{ry:.1f}" font-size="12" fill="#e7ecf3" '
                     f'text-anchor="middle">{esc(label)}</text>')

    # 轴与刻度
    parts.append(f'<line x1="{px0}" y1="{bot}" x2="{px1}" y2="{bot}" stroke="#2a3140" stroke-width="1"/>')
    parts.append(f'<line x1="{px0}" y1="{top}" x2="{px1}" y2="{top}" stroke="#232a35" stroke-width="0.6"/>')
    idxs = [(0, "start"), (n // 2, "middle"), (n - 1, "end")]
    for idx, anchor in idxs:
        ts = amsgs[idx]["ts"]
        x = px0 + idx * bw + bw / 2
        x = min(max(x, px0 + 2), px1 - 2)
        parts.append(f'<text x="{x:.1f}" y="{H - 8}" font-size="12" fill="#8b96a8" '
                     f'text-anchor="{anchor}">{fmt_clock(ts, with_day=True)}</text>')
    ylab = human_num(maxt)
    parts.append(f'<text x="{px0}" y="{top - 30}" font-size="11" fill="#8b96a8">峰值 {esc(ylab)} tokens/条 · {esc(scale_note)}</text>')

    svg = (f'<svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg" role="img" '
           f'aria-label="Token 流柱状图" shape-rendering="crispEdges">{"".join(parts)}</svg>')
    return svg, sqrt_mode, scale_note


def svg_context(turns_w, calib):
    """每轮输入上下文构成的堆叠柱（与 Token 流共享时间轴与几何）。

    段 = 系统提示 / 工具结果(本轮收到) / 历史消息 / 本轮输入，按字符数计、
    以全局校准系数 R (char/tok) 折算为估算 tokens。压缩点画竖直虚线、
    轮间 model_change 画 ▲。校准退化时返回诚实说明而不是图。
    """
    r = calib.get("R")
    n = len(turns_w)
    if n == 0:
        return '<p class="na">n/a（窗口内没有 assistant 消息）</p>'
    if r is None or r <= 0:
        return (f'<p class="na">n/a（校准数据不足：可用轮次 {calib.get("turns_used", 0)} &lt; 10 '
                f'或系数退化，已隐藏构成图以免误导）</p>')
    W, H = 720, 250
    px0, px1 = 6.0, W - 6.0
    top, bot = 46.0, H - 26.0
    ph = bot - top

    est = []
    for t in turns_w:
        ch = t["chars"]
        est.append({k: ch[k] / r for k, _c, _z in CTX_SEGS})
    totals_est = [sum(e.values()) for e in est]
    maxt = max(totals_est)
    if maxt <= 0:
        return '<p class="na">n/a（窗口内各轮字符计数均为 0，无法构成图）</p>'

    bw = (px1 - px0) / n
    w = min(max(bw - 0.7, 0.7), 42.0)
    parts = []
    for i, t in enumerate(turns_w):
        e = est[i]
        tot = totals_est[i]
        if tot <= 0:
            continue
        x = px0 + i * bw + (max(bw - w, 0) / 2 if bw > 48 else 0)
        cum = 0.0
        segs = []
        for key, color, zh in CTX_SEGS:
            v = e[key]
            if v <= 0:
                continue
            hh = v / maxt * ph
            segs.append(f'<rect x="{x:.2f}" y="{bot - cum - hh:.2f}" width="{w:.2f}" '
                        f'height="{hh:.2f}" fill="{color}"/>')
            cum += hh
        if not segs:
            continue
        c = t["ctx"]
        tip = (f"{fmt_clock(t['ts'], with_day=True)} · {esc(t.get('model') or 'n/a')}\n"
               f"估算构成: " + " · ".join(f"{zh} {human_num(round(e[k]))}" for k, _c, zh in CTX_SEGS) +
               f"\n估算合计 ≈{human_num(round(tot))} tokens · 实际 usage "
               f"输入{human_num(c[0])} 缓存读{human_num(c[1])} 缓存写{human_num(c[2])}")
        parts.append(f'<g><title>{esc(tip)}</title>{"".join(segs)}</g>')

    # 覆盖标记：压缩 = 竖直虚线（位于其后第一轮的左边界），model_change = ▲
    n_comp_marks = 0
    n_mc_marks = 0
    for i, t in enumerate(turns_w):
        xe = px0 + i * bw
        comps = t.get("comp_before") or []
        if comps:
            n_comp_marks += 1
            tt = " · ".join(f"compaction {fmt_clock(c[0], with_day=True)}"
                            f"（压缩前 {human_num(c[1]) if c[1] is not None else 'n/a'} tokens）"
                            for c in comps)
            parts.append(f'<line x1="{xe:.2f}" y1="{top - 16:.1f}" x2="{xe:.2f}" y2="{bot:.1f}" '
                         f'stroke="{CTX_COMPACT_COLOR}" stroke-width="1.2" stroke-dasharray="4 3">'
                         f'<title>{esc(tt)}</title></line>')
        if t.get("mc_before"):
            n_mc_marks += 1
            parts.append(f'<path d="M{xe - 4:.2f},{top - 5:.1f} L{xe + 4:.2f},{top - 5:.1f} '
                         f'L{xe:.2f},{top - 13:.1f} Z" fill="{CTX_MC_COLOR}">'
                         f'<title>model_change 于 {esc(fmt_clock(t["ts"], with_day=True))} 前后'
                         f'（轮模型 {esc(t.get("model") or "n/a")}）</title></path>')

    # 轴与刻度（与 Token 流一致）
    parts.append(f'<line x1="{px0}" y1="{bot}" x2="{px1}" y2="{bot}" stroke="#2a3140" stroke-width="1"/>')
    idxs = [(0, "start"), (n // 2, "middle"), (n - 1, "end")]
    for idx, anchor in idxs:
        ts = turns_w[idx]["ts"]
        x = min(max(px0 + idx * bw + bw / 2, px0 + 2), px1 - 2)
        parts.append(f'<text x="{x:.1f}" y="{H - 8}" font-size="12" fill="#8b96a8" '
                     f'text-anchor="{anchor}">{fmt_clock(ts, with_day=True)}</text>')
    parts.append(f'<text x="{px0}" y="{top - 20}" font-size="11" fill="#8b96a8">'
                 f'峰值 ≈{esc(human_num(round(maxt)))} est tokens/轮 · 线性比例 · '
                 f'┊压缩 {n_comp_marks} · ▲模型切换 {n_mc_marks}</text>')

    svg = (f'<svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg" role="img" '
           f'aria-label="每轮上下文构成估算" shape-rendering="crispEdges">{"".join(parts)}</svg>')
    return svg, n_comp_marks, n_mc_marks


def svg_cumulative(amsgs):
    vals = []
    cum = 0.0
    for m in amsgs:
        v = m["usage"].get("totalTokens")
        if isinstance(v, (int, float)):
            cum += v
        vals.append(cum)
    if not vals or cum <= 0:
        return '<p class="na">n/a（窗口内无 totalTokens 数据）</p>'
    W, H = 720, 104
    px0, px1 = 6.0, W - 6.0
    top, bot = 14.0, H - 22.0
    n = len(vals)
    bw = (px1 - px0) / n
    pts = []
    for i, v in enumerate(vals):
        x = px0 + i * bw
        y = bot - (v / cum) * (bot - top)
        pts.append(f"{x:.2f},{y:.2f}")
    line = f'M{px0:.2f},{bot:.2f} L' + ' L'.join(pts)
    area = line + f' L{px1:.2f},{bot:.2f} Z'
    svg = (
        f'<svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg" role="img" '
        f'aria-label="累计 totalTokens">'
        f'<path d="{area}" fill="rgba(76,141,255,0.16)"/>'
        f'<path d="{line}" fill="none" stroke="#4c8dff" stroke-width="1.6"/>'
        f'<line x1="{px0}" y1="{bot}" x2="{px1}" y2="{bot}" stroke="#2a3140" stroke-width="1"/>'
        f'<text x="{px1}" y="{top + 2}" font-size="12" fill="#8b96a8" text-anchor="end">'
        f'累计 {esc(human_num(cum))} totalTokens</text>'
        f'<text x="{px0}" y="{H - 6}" font-size="11" fill="#8b96a8">{esc(fmt_clock(amsgs[0]["ts"], with_day=True))}</text>'
        f'<text x="{px1}" y="{H - 6}" font-size="11" fill="#8b96a8" text-anchor="end">{esc(fmt_clock(amsgs[-1]["ts"], with_day=True))}</text>'
        f'</svg>')
    return svg


def svg_ribbon(ribbon, t0, t1):
    msgs = [(ts, k) for (ts, k) in ribbon if ts is not None]
    if not msgs:
        return '<p class="na">n/a（窗口内无消息事件）</p>'
    MAXCOL = 2500
    if len(msgs) > MAXCOL:
        chunk = math.ceil(len(msgs) / MAXCOL)
        agg = []
        for i in range(0, len(msgs), chunk):
            grp = msgs[i:i + chunk]
            order = {"compaction": 0, "user": 1, "assistant": 2, "toolResult": 3}
            best = min(grp, key=lambda x: order.get(x[1], 9))
            agg.append(best)
        msgs = agg
    n = len(msgs)
    W, H = 720, 30
    px0, px1 = 4.0, W - 4.0
    cw = (px1 - px0) / n
    w = max(cw, 0.7)
    parts = []
    cmap = {k: c for k, c, _ in RIBBON_COLORS}
    for i, (ts, kind) in enumerate(msgs):
        x = px0 + i * cw
        parts.append(f'<rect x="{x:.2f}" y="6" width="{w:.2f}" height="18" fill="{cmap.get(kind, "#555")}">'
                     f'<title>{esc(fmt_clock(ts, with_day=True))} · {esc(kind)}</title></rect>')
    svg = (f'<svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg" role="img" '
           f'aria-label="事件密度带" shape-rendering="crispEdges">'
           f'<line x1="{px0}" y1="26" x2="{px1}" y2="26" stroke="#2a3140" stroke-width="1"/>'
           f'<text x="{px0}" y="24" font-size="10" fill="#8b96a8">{esc(fmt_hm(msgs[0][0]))}</text>'
           f'<text x="{px1}" y="24" font-size="10" fill="#8b96a8" text-anchor="end">{esc(fmt_hm(msgs[-1][0]))}</text>'
           f'{"".join(parts)}</svg>')
    return svg


def svg_sub_timeline(session):
    t0, t1 = session["t_first"], session["t_last"]
    spawns = session["spawn_ts"]
    reports = session["sub_reports"]
    if t0 is None or t1 is None or t1 <= t0 or not (spawns or reports):
        return '<p class="na">n/a（无 spawn/报告时间可标）</p>'
    W, H = 720, 54
    px0, px1 = 10.0, W - 10.0

    def X(ts):
        return px0 + (ts - t0) / (t1 - t0) * (px1 - px0)

    parts = [f'<line x1="{px0}" y1="{H/2}" x2="{px1}" y2="{H/2}" stroke="#2a3140" stroke-width="1"/>']
    for ts, name in spawns:
        if ts is None:
            continue
        x = X(ts)
        parts.append(f'<circle cx="{x:.1f}" cy="{H/2 - 8}" r="3.4" fill="none" stroke="#8b96a8" stroke-width="1.2">'
                     f'<title>{esc(fmt_clock(ts, with_day=True))} · spawn（{esc(name)}）</title></circle>')
    color = {"ready": "#f5a63b", "done": "#3fbf7f"}
    for r in reports:
        if r["ts"] is None:
            continue
        x = X(r["ts"])
        c = color.get(r["status"], "#8b96a8")
        title = f'{fmt_clock(r["ts"], with_day=True)} · {r["id"] or "n/a"} · {r["label"] or "n/a"} · {r["status"] or "report"} · {r["chars"]} 字符'
        parts.append(f'<circle cx="{x:.1f}" cy="{H/2 + 8}" r="4" fill="{c}">'
                     f'<title>{esc(title)}</title></circle>')
    parts.append(f'<text x="{px0}" y="10" font-size="10.5" fill="#8b96a8">{esc(fmt_day(t0))}</text>')
    parts.append(f'<text x="{px1}" y="10" font-size="10.5" fill="#8b96a8" text-anchor="end">{esc(fmt_day(t1))}</text>')
    return (f'<svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg" role="img" '
            f'aria-label="子代理时间线">{"".join(parts)}</svg>')


# ------------------------------------------------------------------ HTML ---

CSS = """
:root{--bg:#0e1116;--card:#161b22;--line:#242c39;--tx:#e7ecf3;--mut:#8b96a8;
--blue:#4c8dff;--teal:#2fb9c9;--orange:#f5a63b;--red:#e5534b;--green:#3fbf7f;}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--tx);font:14px/1.55 -apple-system,BlinkMacSystemFont,
"PingFang SC","Noto Sans SC","Microsoft YaHei",sans-serif;
-webkit-text-size-adjust:100%}
.wrap{max-width:1080px;margin:0 auto;padding:16px 12px 44px}
h1{font-size:20px;margin:2px 0 2px;letter-spacing:.3px}
.sub{color:var(--mut);font-size:12px;margin:2px 0 10px}
.mut{color:var(--mut)} .small{font-size:12px}
.nav{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:2px;height:28px;
margin:0 -12px 8px;padding:0 8px;background:rgba(14,17,22,.88);
backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
border-bottom:1px solid var(--line);overflow-x:auto;white-space:nowrap;scrollbar-width:none}
.nav::-webkit-scrollbar{display:none}
.nav a{flex:0 0 auto;color:var(--mut);font-size:12px;line-height:28px;text-decoration:none;padding:0 8px}
.nav a:hover,.nav a:focus{color:var(--tx)}
details.sec{margin-top:4px;scroll-margin-top:34px}
details.sec>summary{cursor:pointer;list-style:none;font-size:16px;font-weight:600;
margin:24px 0 8px;padding-left:9px;border-left:3px solid var(--blue);
display:flex;align-items:baseline;gap:8px}
details.sec>summary .en{color:var(--mut);font-size:12px;font-weight:400}
details.sec>summary::after{content:"▾";color:var(--mut);font-size:11px;margin-left:auto;padding:0 4px}
details.sec:not([open])>summary::after{content:"▸"}
details.sec>summary::-webkit-details-marker{display:none}
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:8px;margin-top:12px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 10px;min-width:0}
.kpi b{display:block;font-size:17px;font-weight:600;font-variant-numeric:tabular-nums;
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kpi span{color:var(--mut);font-size:11.5px;display:block}
.kpi.wide{grid-column:span 2}
.kpi b small{font-size:12px;color:var(--mut);font-weight:400}
svg{width:100%;height:auto;display:block}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:10px}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin:8px 2px 2px;font-size:12px;color:var(--mut)}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.badges{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 4px}
.pill{display:inline-flex;align-items:center;gap:5px;background:var(--card);border:1px solid var(--line);
border-radius:999px;padding:4px 11px;font-size:12.5px;font-variant-numeric:tabular-nums}
.pill b{font-weight:600}
.pill.warn{border-color:rgba(229,83,75,.45)}
.pill.ok{color:var(--mut)}
.tool-row{padding:7px 2px;border-bottom:1px dashed var(--line)}
.tool-row:last-child{border-bottom:none}
.tool-l1{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.tool-name{font-weight:600;font-size:13.5px}
.tool-meta{color:var(--mut);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.tool-meta em{color:var(--red);font-style:normal}
.barwrap{background:#0b0e13;border:1px solid var(--line);border-radius:5px;height:12px;margin-top:5px;overflow:hidden}
.bar{height:100%;background:var(--blue);min-width:2px}
.bar .err{height:100%;background:var(--red);float:left;min-width:2px}
.samples{margin:5px 0 2px;padding:0;list-style:none}
.samples li{font:11.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--mut);
white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.samples li::before{content:"▸ ";color:var(--teal)}
.sas{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px}
.sa-card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:9px 11px;min-width:0}
.sa-head{display:flex;justify-content:space-between;gap:8px;align-items:baseline;margin-bottom:3px}
.sa-head b{font-size:14px}
.sa-head span{color:var(--teal);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sa-line{font-size:12px;color:var(--mut);font-variant-numeric:tabular-nums}
.sa-line b{color:var(--tx);font-weight:500}
.tblwrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:12.5px;font-variant-numeric:tabular-nums}
th,td{text-align:right;padding:6px 9px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--mut);font-weight:500;font-size:11.5px}
td:first-child,th:first-child{text-align:left}
tr:last-child td{border-bottom:none}
.warn{color:#ffb4ae;background:rgba(229,83,75,.08);border:1px solid rgba(229,83,75,.35);
border-radius:8px;padding:7px 10px;font-size:12.5px;margin-top:8px}
.diag-block{margin-bottom:6px}
.diag-block h3{font-size:13px;margin:10px 0 4px;color:var(--tx)}
footer{margin-top:30px;padding-top:12px;border-top:1px solid var(--line);color:var(--mut);
font-size:11.5px;line-height:1.7}
footer code{font:11px ui-monospace,Menlo,monospace;color:#a8b3c7}
.na{color:var(--mut);font-size:13px;background:var(--card);border:1px dashed var(--line);
border-radius:8px;padding:9px 12px}
@media (min-width:760px){ .kpi b{font-size:19px} h1{font-size:23px} }
"""


def kpi_card(label, value, wide=False, extra=None):
    cls = "kpi wide" if wide else "kpi"
    ex = f'<span>{esc(extra)}</span>' if extra else ""
    return f'<div class="{cls}"><span>{esc(label)}</span><b>{value}</b>{ex}</div>'


def section(sec_id, zh, en, inner):
    return (f'<details class="sec" id="{sec_id}" open><summary>{esc(zh)}'
            f'<span class="en">{esc(en)}</span></summary>\n{inner}</details>')


def badges_html(d):
    """KPI 下方的诊断徽章行（启发式）。"""
    diag = d.get("diag") or {}
    pills = []
    reps = diag.get("repeats") or []
    if reps:
        top = reps[0]
        pills.append(f'<span class="pill">🔁 重复调用 <b>{len(reps)}</b> 组 · '
                     f'最多 {esc(top["name"])} ×{top["n"]}</span>')
    st = diag.get("streak")
    if st and st["n"] >= 2:
        tool = max(st["tools"].items(), key=lambda kv: kv[1])[0]
        pills.append(f'<span class="pill warn">⛓️ 连续失败 <b>{st["n"]}</b> 次 · {esc(tool)} · '
                     f'{esc(fmt_clock(st["start"], with_day=True))}→{esc(fmt_clock(st["end"]))}</span>')
    spin = diag.get("spin") or []
    if spin:
        pills.append(f'<span class="pill warn">🌀 打转 <b>{len(spin)}</b> 组 · '
                     f'最多 {esc(spin[0]["name"])} 10分钟内 ×{spin[0]["win_max"]}</span>')
    if not pills:
        pills.append('<span class="pill ok">未检出重复调用(≥3 同参) / 连续失败(≥2) / 打转模式</span>')
    note = ('<div class="sub small">启发式规则，仅供定位，不代表真实错误率。</div>')
    return '<div class="badges">' + "".join(pills) + '</div>' + note


def diag_detail_html(d):
    diag = d.get("diag") or {}
    blocks = []

    # 重复调用 top-5
    reps = diag.get("repeats") or []
    if reps:
        rows = ["<tr><th>工具</th><th>次数</th><th>首次</th><th>末次</th><th>跨度</th><th>10分钟内峰值</th></tr>"]
        for r in reps[:5]:
            span = (fmt_span_secs(r["last"] - r["first"])
                    if (r["first"] is not None and r["last"] is not None) else "n/a")
            rows.append(f'<tr><td>{esc(r["name"])}</td><td>{r["n"]}</td>'
                        f'<td>{esc(fmt_clock(r["first"], with_day=True))}</td>'
                        f'<td>{esc(fmt_clock(r["last"], with_day=True))}</td>'
                        f'<td>{esc(span)}</td><td>×{r["win_max"]}</td></tr>')
        blocks.append('<div class="diag-block"><h3>🔁 重复调用（top 5，完全相同参数 ≥3 次）</h3>'
                      f'<div class="card tblwrap"><table>{"".join(rows)}</table></div></div>')
    else:
        blocks.append('<div class="diag-block"><h3>🔁 重复调用</h3>'
                      '<p class="na">n/a（没有 ≥3 次完全相同参数的调用组）</p></div>')

    # 连续失败
    st = diag.get("streak")
    if st:
        tools_txt = "、".join(f"{esc(k)}×{v}" for k, v in
                             sorted(st["tools"].items(), key=lambda kv: -kv[1]))
        span = (fmt_span_secs(st["end"] - st["start"])
                if (st["start"] is not None and st["end"] is not None) else "n/a")
        rec = diag.get("recovery")
        rec_txt = fmt_span_secs(rec) if rec is not None else "n/a（直至会话结束未恢复）"
        blocks.append(f'<div class="diag-block"><h3>⛓️ 最长连续失败（全局连续 isError streak）</h3>'
                      f'<div class="card"><div class="sa-line">工具 <b>{tools_txt}</b> · '
                      f'连续 <b>{st["n"]}</b> 次 · 时间 <b>{esc(fmt_clock(st["start"], with_day=True))}'
                      f'→{esc(fmt_clock(st["end"]))}</b>（跨度 {esc(span)}）</div>'
                      f'<div class="sa-line">恢复用时（至下一个成功结果）<b>{esc(rec_txt)}</b>'
                      f'{" · 未达 ≥2 连续，不显示徽章" if st["n"] < 2 else ""}</div></div></div>')
    else:
        blocks.append('<div class="diag-block"><h3>⛓️ 连续失败</h3>'
                      '<p class="na">n/a（没有 isError=true 的工具结果）</p></div>')

    # 打转
    spin = diag.get("spin") or []
    if spin:
        rows = ["<tr><th>工具</th><th>10分钟内峰值</th><th>窗口起</th><th>窗口止</th><th>总会话次数</th></tr>"]
        for r in spin[:5]:
            rows.append(f'<tr><td>{esc(r["name"])}</td><td>×{r["win_max"]}</td>'
                        f'<td>{esc(fmt_clock(r["win_start"], with_day=True))}</td>'
                        f'<td>{esc(fmt_clock(r["win_end"], with_day=True))}</td>'
                        f'<td>{r["n"]}</td></tr>')
        blocks.append('<div class="diag-block"><h3>🌀 打转（同一参数调用 10 分钟窗口内 ≥3 次）</h3>'
                      f'<div class="card tblwrap"><table>{"".join(rows)}</table></div></div>')
    else:
        blocks.append('<div class="diag-block"><h3>🌀 打转</h3>'
                      '<p class="na">n/a（没有 10 分钟窗口内 ≥3 次同参调用的组）</p></div>')

    return "".join(blocks)


def build_html(session, cards, sub_dir, last_n, all_mode, parse_mode):
    t0, t1 = session["t_first"], session["t_last"]
    fname = os.path.basename(session["path"])
    roles = session["roles"]
    usage = session["usage"]
    n_asst = len(session["assistant"])
    n_calls = len(session["tool_calls"])
    n_results = len(session["tool_results"])

    # 匹配率自检
    call_ids = {c[2] for c in session["tool_calls"] if c[2] is not None}
    res_ids = {r[1] for r in session["tool_results"] if r[1] is not None}
    union = call_ids | res_ids
    match_rate = (len(call_ids & res_ids) / len(union)) if union else None
    mismatch_frac = (1 - match_rate) if match_rate is not None else 0.0

    # ---- 头部 KPI ----
    win_txt = (f"{fmt_day(t0)} → {fmt_day(t1)} UTC"
               if t0 is not None and t1 is not None else "n/a")
    dur = fmt_span_secs((t1 - t0) if (t0 is not None and t1 is not None) else None)
    meta = session["meta"]
    meta_line = " · ".join(esc(f"{k}: {v}") for k, v in meta.items()) or "n/a"

    role_brief = " · ".join([
        f"助手 {roles.get('assistant', 0)}", f"用户 {roles.get('user', 0)}",
        f"工具结果 {roles.get('toolResult', 0)}", f"系统 {roles.get('system', 0)}",
    ])
    om_line = " · ".join(f"{k.replace('om.', '')} {v}" for k, v in sorted(session["om"].items())) or "无"

    # 成本：全部为 0 时如实说明，而不是 $0.0000
    cost_n, cost_sum = session["cost_total"][1], session["cost_total"][0]
    if cost_n and cost_sum == 0:
        cost_disp = "<small>此端点无计费数据</small>"
        cost_stdout = "无计费数据"
    elif cost_n:
        cost_disp = esc(f"${cost_sum:.4f}")
        cost_stdout = f"${cost_sum:.4f}"
    else:
        cost_disp = esc("n/a")
        cost_stdout = "n/a"

    kpis = [
        kpi_card("数据窗口", f"<small>{esc(win_txt)}</small>", wide=True,
                 extra=f"时长 {dur} · {esc(fname)}"),
        kpi_card("输入 tokens", esc(human_num(usage["input"][0] if usage["input"][1] else None))),
        kpi_card("缓存读 tokens", esc(human_num(usage["cacheRead"][0] if usage["cacheRead"][1] else None))),
        kpi_card("缓存写 tokens", esc(human_num(usage["cacheWrite"][0] if usage["cacheWrite"][1] else None))),
        kpi_card("输出 tokens", esc(human_num(usage["output"][0] if usage["output"][1] else None))),
        kpi_card("推理 tokens", esc(human_num(usage["reasoning"][0] if usage["reasoning"][1] else None))),
        kpi_card("累计成本", cost_disp),
        kpi_card("消息数", esc(human_num(sum(roles.values()))), extra=role_brief),
        kpi_card("工具调用", esc(human_num(n_calls)),
                 extra=f"结果 {n_results} 条"),
        kpi_card("子代理报告", esc(human_num(len(session["sub_reports"]))),
                 extra=f"磁盘目录 {len(cards)} 个"),
        kpi_card("压缩", esc(human_num(session["compactions"]) if session["compactions"] else "0"),
                 extra=f"上下文编辑 {session['context_edits']} · model_change {session['model_changes']}"),
        kpi_card("om. 记录", esc(human_num(sum(session["om"].values())) if session["om"] else "0"),
                 extra=om_line),
    ]

    # ---- Token 流 ----
    truncated = n_asst > last_n
    amsgs = session["assistant"][-last_n:] if truncated else session["assistant"]
    turns_w = session["turns"][-last_n:] if truncated else session["turns"]
    win_note = ""
    if truncated:
        st = amsgs[0]["ts"] if amsgs else None
        win_note = (f"时间序列已截取最后 {last_n} 条 assistant 消息"
                    f"（自 {fmt_clock(st, with_day=True)} 起）；KPI 与工具统计仍为全文件。")
    else:
        win_note = f"时间序列覆盖全部 {n_asst} 条 assistant 消息。"
    flow_svg, _sqrt_mode, scale_note = svg_token_flow(amsgs, win_note)
    cum_svg = svg_cumulative(amsgs)
    legend = "".join(f'<span><i style="background:{c}"></i>{zh}</span>' for _k, c, zh in SEG_ORDER)

    # ---- 每轮上下文构成（估算） ----
    calib = session.get("calibration") or {}
    ctx_svg = svg_context(turns_w, calib)
    r_txt = f"{calib['R']:.2f}" if calib.get("R") else "n/a"
    ctx_note = (f"构成按字符比例估算 (校准系数 R≈{esc(r_txt)} char/tok，"
                f"校准目标 = {esc(calib.get('target') or 'usage.input+cacheRead+cacheWrite')}，"
                f"校准轮次 {calib.get('turns_used', 0)})。仅统计文本内容；工具调用参数与端点注入的"
                f"系统提示（会话文件中不可见）未计入。压缩点后历史计数已重置为压缩摘要长度。")
    ctx_legend = "".join(f'<span><i style="background:{c}"></i>{zh}</span>' for _k, c, zh in CTX_SEGS)
    ctx_legend += (f'<span><i style="background:none;border-top:2px dashed {CTX_COMPACT_COLOR};'
                   f'height:0;width:14px;border-radius:0"></i>压缩</span>'
                   f'<span style="color:{CTX_MC_COLOR}">▲ 模型切换</span>')

    # ---- 工具调用 ----
    per_tool = {}
    for _ts, name, _cid, _s, _nh in session["tool_calls"]:
        per_tool.setdefault(name, {"calls": 0})["calls"] += 1
    for name, (errs, dsum, dn) in session["tool_err_dur"].items():
        e = per_tool.setdefault(name, {"calls": 0})
        e["errors"] = errs
        e["avg"] = (dsum / dn) if dn else None
    tool_rows = []
    if per_tool:
        mx = max(e["calls"] for e in per_tool.values())
        for name, e in sorted(per_tool.items(), key=lambda kv: -kv[1]["calls"]):
            err = e.get("errors", 0)
            avg = e.get("avg")
            pct = e["calls"] / mx * 100
            err_pct = (err / e["calls"] * 100) if e["calls"] else 0
            meta_txt = f'{e["calls"]} 次'
            if err:
                meta_txt += f' · <em>错误 {err}</em>'
            meta_txt += f' · 均 {esc(human_dur(avg))}'
            bar = f'<div class="bar" style="width:{pct:.1f}%">'
            if err:
                bar += f'<span class="err" style="width:{err_pct:.1f}%"></span>'
            bar += "</div>"
            row = (f'<div class="tool-row"><div class="tool-l1">'
                   f'<span class="tool-name">{esc(name)}</span>'
                   f'<span class="tool-meta">{meta_txt}</span></div>'
                   f'<div class="barwrap">{bar}</div>')
            if name in session["tool_args"] and session["tool_args"][name]:
                lis = "".join(f"<li>{esc(s)}</li>" for s in session["tool_args"][name])
                row += f'<ul class="samples">{lis}</ul>'
            row += "</div>"
            tool_rows.append(row)
    else:
        tool_rows = ['<p class="na">n/a（全文件没有工具调用）</p>']

    # ---- 子代理 ----
    tl_svg = svg_sub_timeline(session)
    sa_cards = []
    for c in cards:
        reps = c["reports"]
        if reps:
            rtxt = " · ".join(
                f'{esc(r["status"] or "report")} {fmt_hm(r["ts"])}' for r in reps)
            chars = sum(r["chars"] for r in reps)
            rep_line = f'报告 <b>{rtxt}</b> · {len(reps)} 条 · {human_num(chars)} 字符'
        else:
            rep_line = "报告 <b>n/a</b>"
        span = c["span"]
        span_txt = (f"{fmt_hm(span[0])}→{fmt_hm(span[1])} UTC" if span else "n/a")
        disk_line = (f'磁盘 events <b>{human_num(c["n_events"])}</b> · 跨度 <b>{esc(span_txt)}</b>'
                     f'（文件时间） · result.md <b>{esc(human_bytes(c["result_size"]))}</b>'
                     f' · 末事件 <b>{esc(c["last_event"] or "n/a")}</b>')
        extra = (f'transcript.log {esc(human_bytes(c["transcript_size"]))}'
                 if c["transcript_size"] is not None else "transcript.log n/a")
        flag = "" if (c["in_report"] or c["in_window"]) else "（窗口外，因 --subagents-all 显示）"
        sa_cards.append(
            f'<div class="sa-card"><div class="sa-head"><b>{esc(c["id"])}</b>'
            f'<span>{esc(c["label"] or "n/a")}</span></div>'
            f'<div class="sa-line">{rep_line}</div>'
            f'<div class="sa-line">{disk_line}</div>'
            f'<div class="sa-line small">{esc(extra)}{esc(flag)}</div></div>')
    sa_cards_html = "".join(sa_cards) or '<p class="na">n/a（没有匹配的子代理目录）</p>'
    sa_note = ("注：events.jsonl 无时间戳字段，跨度为文件创建→修改时间（UTC）；"
               f"卡片过滤 = 被子代理报告引用 或 目录修改时间落在会话窗口内"
               f"{'（当前: 全部目录）' if all_mode else '（--subagents-all 查看全部）'}。")

    # ---- 模型 ----
    models = {}
    for m in session["assistant"]:
        key = m.get("model") or "n/a"
        e = models.setdefault(key, {"n": 0, "in": 0, "in_n": 0, "out": 0, "out_n": 0,
                                    "cr": 0, "cr_n": 0, "dur": 0.0, "dur_n": 0})
        e["n"] += 1
        u = m["usage"]
        v = u.get("input")
        if isinstance(v, (int, float)):
            e["in"] += v
            e["in_n"] += 1
        v = u.get("output")
        if isinstance(v, (int, float)):
            e["out"] += v
            e["out_n"] += 1
        v = u.get("cacheRead")
        if isinstance(v, (int, float)):
            e["cr"] += v
            e["cr_n"] += 1
        if isinstance(m["durationMs"], (int, float)):
            e["dur"] += m["durationMs"]
            e["dur_n"] += 1
    if models:
        mrows = ["<tr><th>模型</th><th>响应</th><th>输入</th><th>缓存读</th><th>输出</th><th>均耗时</th></tr>"]
        for name, e in sorted(models.items(), key=lambda kv: -kv[1]["n"]):
            mrows.append(
                f'<tr><td>{esc(name)}</td><td>{e["n"]}</td>'
                f'<td>{esc(human_num(e["in"] if e["in_n"] else None))}</td>'
                f'<td>{esc(human_num(e["cr"] if e["cr_n"] else None))}</td>'
                f'<td>{esc(human_num(e["out"] if e["out_n"] else None))}</td>'
                f'<td>{esc(human_dur(e["dur"] / e["dur_n"]) if e["dur_n"] else "n/a")}</td></tr>')
        model_html = (f'<div class="card tblwrap"><table>{"".join(mrows)}</table></div>'
                      f'<div class="sub small">输入/输出为 usage.input / usage.output 原始字段之和；'
                      f'缓存读列为 usage.cacheRead 之和；缓存写与推理 tokens 见顶部 KPI。'
                      + (f'成本行：{esc(cost_stdout)}。' if cost_n else ''))
        model_html += '</div>'
    else:
        model_html = '<p class="na">n/a（没有 assistant 消息）</p>'

    # ---- 事件密度 ----
    ribbon_svg = svg_ribbon(session["ribbon"], t0, t1)
    rlegend = "".join(f'<span><i style="background:{c}"></i>{zh}</span>' for _k, c, zh in RIBBON_COLORS)

    # ---- footer / 警告 ----
    warn = ""
    if match_rate is not None and mismatch_frac > 0.05:
        warn = (f'<div class="warn">⚠ toolCall↔toolResult 匹配率仅 {match_rate * 100:.1f}%'
                f'（>5% 未匹配阈值），工具统计可能失真。</div>')
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    parse_mode_txt = {"full": "全量解析", "incr": "增量解析", "cache": "缓存命中"}[parse_mode]
    footer = (f'pi_dashboard.py · generated {now_iso} · from <code>{esc(fname)}</code> '
              f'({session["parsed"]} events parsed, {session["skipped"]} skipped, '
              f'解析方式: {parse_mode_txt})'
              f'<br>匹配自检: toolCall {len(call_ids)} 个 id ↔ toolResult {len(res_ids)} 个 id，'
              f'匹配率 {esc(f"{match_rate * 100:.2f}%" if match_rate is not None else "n/a")}'
              f'<br>子代理目录 <code>{esc(os.path.abspath(sub_dir))}</code> · 所有数值均直接来自会话文件，'
              f'缺失字段显示 n/a；估算值已标注')

    title = f"Pi 活动仪表盘 · {esc(fname)}"
    nav = ('<nav class="nav" aria-label="视图导航">'
           '<a href="#sec-kpi">KPI</a><a href="#sec-flow">Token流</a>'
           '<a href="#sec-ctx">上下文</a><a href="#sec-tools">工具</a>'
           '<a href="#sec-diag">诊断</a><a href="#sec-sub">子代理</a>'
           '<a href="#sec-model">模型</a><a href="#sec-ribbon">密度</a></nav>')

    kpi_inner = (f'<div class="kpis">{"".join(kpis)}</div>{badges_html(session)}')
    flow_inner = (f'<div class="sub">{esc(win_note)} {esc(scale_note) if scale_note else ""}</div>'
                  f'<div class="card">{flow_svg}</div>'
                  f'<div class="legend">{legend}'
                  f'<span style="margin-left:auto">柱高 = 输入+缓存读+输出+推理（每条 assistant 消息）</span></div>'
                  f'<div class="card" style="margin-top:10px">{cum_svg}</div>')
    ctx_inner = (f'<div class="sub">{esc(ctx_note)}</div>'
                 f'<div class="card">{ctx_svg}</div>'
                 f'<div class="legend">{ctx_legend}</div>')
    tools_inner = (f'<div class="sub">条长 = 调用次数占比；条内红色段 = 错误占比（isError，按 toolCallId 关联 toolResult）。前 3 名工具附参数样本。</div>'
                   f'<div class="card">{"".join(tool_rows)}</div>')
    diag_inner = (f'<div class="sub">全部为启发式计算（详见各块说明），不代表真实错误率。</div>'
                  f'{diag_detail_html(session)}')
    sub_inner = (f'<div class="sub">时间线：○ spawn（subagent/subagent_spawn 调用） · '
                 f'<i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f5a63b"></i> ready 报告 · '
                 f'<i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#3fbf7f"></i> done 报告</div>'
                 f'<div class="card">{tl_svg}</div>'
                 f'<div class="sub small" style="margin-top:6px">{esc(sa_note)}</div>'
                 f'<div class="sas">{sa_cards_html}</div>')
    ribbon_inner = (f'<div class="sub">每列 ≈ 一条消息，按会话顺序排列（>2500 条时按多数角色聚合）。悬停可看时间与角色。</div>'
                    f'<div class="card">{ribbon_svg}</div><div class="legend">{rlegend}</div>')

    parts = [
        "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">",
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f"<title>{title}</title>\n<style>{CSS}</style>\n</head>\n<body>\n<div class=\"wrap\">",
        nav,
        f"<h1>Pi 会话活动仪表盘</h1>"
        f'<div class="sub">{meta_line}</div>',
        section("sec-kpi", "概览 KPI", "kpi", kpi_inner),
        section("sec-flow", "Token 流", "token flow", flow_inner),
        section("sec-ctx", "每轮上下文构成", "context per turn (估算)", ctx_inner),
        section("sec-tools", "工具调用", "tools", tools_inner),
        section("sec-diag", "诊断徽章", "diagnostics (启发式)", diag_inner),
        section("sec-sub", "子代理", "subagents", sub_inner),
        section("sec-model", "模型", "models", model_html),
        section("sec-ribbon", "事件密度", "event ribbon", ribbon_inner),
        f'{warn}<footer>{footer}</footer>',
        "</div>\n</body>\n</html>",
    ]
    return "\n".join(parts)


# ------------------------------------------------------------------- main ---

def main(argv=None):
    ap = argparse.ArgumentParser(description="Pi 会话活动仪表盘生成器（单文件 HTML，仅标准库）")
    ap.add_argument("--session", required=True, help="会话 .jsonl 路径，或 'latest'")
    ap.add_argument("--subagents-dir", default=DEFAULT_SUBAGENTS_DIR)
    ap.add_argument("--out", default="/tmp/pi-dashboard.html")
    ap.add_argument("--last-n", type=int, default=400,
                    help="时间序列视图（柱状图/事件带）截取的最后 N 条 assistant 消息")
    ap.add_argument("--subagents-all", action="store_true",
                    help="子代理卡片包含全部目录，而不只是会话窗口内/被引用的")
    a = ap.parse_args(argv)

    path = resolve_session(a.session)
    events, pinfo = load_events(path)
    last_n = max(1, a.last_n)

    # ---- 解析计时行 ----
    mode = pinfo["mode"]
    secs = pinfo["secs"]
    if mode == "full":
        print(f"解析: 全量 {secs:.2f}s (行数 {pinfo['lines']}, 解析失败 {pinfo['skipped']})")
    elif mode == "incr":
        print(f"解析: 全量 0.00s(命中缓存) / 增量 {secs:.2f}s "
              f"(跳过 {pinfo.get('cached_lines', 0)} 行, 新增 {pinfo.get('added', 0)} 行)")
    else:
        print(f"解析: 缓存命中 {secs:.2f}s (跳过 {pinfo['lines']} 行)")

    session = build_session(events, path, pinfo["lines"], pinfo["skipped"])
    analyze_diagnostics(session)
    calib = fit_calibration(session)
    cards = scan_subagents(a.subagents_dir, session, a.subagents_all)

    if mode != "cache":
        save_cache(path, events, pinfo, calib)

    html_doc = build_html(session, cards, a.subagents_dir, last_n, a.subagents_all, mode)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(html_doc)

    # ---- stdout 一行式摘要 ----
    usage = session["usage"]
    roles = session["roles"]
    call_ids = {c[2] for c in session["tool_calls"] if c[2] is not None}
    res_ids = {r[1] for r in session["tool_results"] if r[1] is not None}
    union = call_ids | res_ids
    rate = (len(call_ids & res_ids) / len(union) * 100) if union else None
    rate_txt = f"{rate:.2f}%" if rate is not None else "n/a"

    def tk(k):
        return human_num(usage[k][0]) if usage[k][1] else "n/a"

    cost_n, cost_sum = session["cost_total"][1], session["cost_total"][0]
    if cost_n and cost_sum == 0:
        cost_stdout = "无计费数据"
    elif cost_n:
        cost_stdout = f"${cost_sum:.4f}"
    else:
        cost_stdout = "n/a"

    diag = session["diag"]
    streak = diag["streak"]
    streak_txt = "n/a"
    if streak:
        tool = max(streak["tools"].items(), key=lambda kv: kv[1])[0]
        rec = diag["recovery"]
        streak_txt = f"{streak['n']} ({tool}, 恢复 {fmt_span_secs(rec) if rec is not None else 'n/a'})"

    print(
        f"summary: file={os.path.basename(path)} events={session['parsed']} skipped={session['skipped']} | "
        f"tokens input={tk('input')} output={tk('output')} cacheRead={tk('cacheRead')} "
        f"cacheWrite={tk('cacheWrite')} reasoning={tk('reasoning')} cost_total={cost_stdout}"
    )
    print(
        f"  messages={sum(roles.values())} (assistant={roles.get('assistant', 0)} "
        f"user={roles.get('user', 0)} toolResult={roles.get('toolResult', 0)} "
        f"system={roles.get('system', 0)}) | toolCalls={len(session['tool_calls'])} "
        f"toolResults={len(session['tool_results'])} matchRate={rate_txt} | "
        f"subagentReports={len(session['sub_reports'])} subagentDirs={len(cards)} | "
        f"compactions={session['compactions']}"
    )
    print(
        f"diagnostics: repeat_groups={len(diag['repeats'])} (≥3 同参, top: "
        f"{diag['repeats'][0]['name'] + ' ×' + str(diag['repeats'][0]['n']) if diag['repeats'] else 'n/a'}) | "
        f"spin_groups={len(diag['spin'])} (10min 窗口 ≥3) | "
        f"max_error_streak={streak_txt} | "
        f"badges_note=启发式规则仅供定位"
    )
    # 上下文构成视图校验信息
    turns_w = session["turns"][-last_n:]
    comp_w = sum(1 for t in turns_w if t["comp_before"])
    mc_w = sum(1 for t in turns_w if t["mc_before"])
    r_txt = f"{calib['R']:.2f}" if calib.get("R") else "n/a"
    sanity_txt = "n/a"
    if calib.get("R"):
        lt = None
        for t in reversed(session["turns"]):
            if sum(v for v in t["ctx"] if isinstance(v, (int, float))) > 0:
                lt = t
                break
        if lt:
            ch = lt["chars"]
            est = (ch["sys"] + ch["tools"] + ch["hist"] + ch["user"]) / calib["R"]
            act = sum(v for v in lt["ctx"] if isinstance(v, (int, float)))
            delta = (est - act) / act * 100 if act else 0.0
            sanity_txt = (f"末轮估算 ≈{est:,.0f} tok vs usage-context {act:,.0f} tok "
                          f"(usage.input={lt['ctx'][0]}, Δ{delta:+.1f}%)")
    print(
        f"context_view: 校准系数 R≈{r_txt} char/tok (目标 {calib.get('target')}, "
        f"轮次 {calib.get('turns_used')}) | compaction_markers={session['compactions']} "
        f"(窗口内 {comp_w}) | model_change_markers={session['model_changes']} (窗口内 {mc_w}) | "
        f"sanity: {sanity_txt}"
    )
    print(f"  out={a.out} ({os.path.getsize(a.out)} bytes) window="
          f"{fmt_day(session['t_first'])} → {fmt_day(session['t_last'])} UTC, "
          f"last_n={last_n}, parse_mode={mode}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
