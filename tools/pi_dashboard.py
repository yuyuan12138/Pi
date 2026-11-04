#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pi_dashboard.py — 从 Pi 会话 JSONL 生成单文件活动仪表盘（仅 Python 标准库）。

用法:
  python3 pi_dashboard.py --session <path|latest> [--subagents-dir DIR]
                         [--out /tmp/pi-dashboard.html] [--last-n 400]
                         [--subagents-all]

所有数字均由会话文件计算得出；字段缺失时显示 n/a 而不是 0。
"""

import argparse
import glob
import html
import json
import math
import os
import re
import sys
from datetime import datetime, timezone

DEFAULT_SUBAGENTS_DIR = "/Users/yuyuan/PiAgents/.pi/subagents"
DEFAULT_SESSIONS_ROOT = os.path.expanduser("~/.pi/agent/sessions")

REPORT_RE = re.compile(r"^\[subagent\s+([^\]·]+?)\s*·\s*([^\]]+?)\]\s*([^:\s]+)\s*:")

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


def parse_session(path):
    d = {
        "path": path,
        "size": os.path.getsize(path) if os.path.exists(path) else None,
        "parsed": 0,
        "skipped": 0,
        "meta": {},
        "t_first": None,
        "t_last": None,
        "roles": {},                       # role -> count
        "usage": {k: [0, 0] for k in ("input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens")},
        "cost_total": [0.0, 0],
        "assistant": [],                   # 顺序 assistant 消息
        "tool_calls": [],                  # (ts, name, id, sample)
        "tool_results": [],                # (ts, id, name, isError, durationMs)
        "tool_err_dur": {},                # name -> [errors, dur_sum, dur_n]  (来自匹配的 toolResult)
        "tool_args": {},                   # name -> [sample, ...] 最多 3 个
        "sub_reports": [],                 # {ts,id,label,status,chars}
        "spawn_ts": [],                    # spawn 类 toolCall 时间
        "compactions": 0,
        "context_edits": 0,
        "model_changes": 0,
        "om": {},                          # customType -> count
        "ribbon": [],                      # (ts, kind) kind in user/assistant/toolResult/compaction
    }
    usage = d["usage"]

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                d["skipped"] += 1
                continue
            if not isinstance(o, dict):
                d["skipped"] += 1
                continue
            d["parsed"] += 1
            t = o.get("type")
            ts = parse_ts(o.get("timestamp"))
            if ts is not None:
                if d["t_first"] is None or ts < d["t_first"]:
                    d["t_first"] = ts
                if d["t_last"] is None or ts > d["t_last"]:
                    d["t_last"] = ts

            if t == "session":
                d["meta"] = {k: o.get(k) for k in ("cwd", "id", "version") if o.get(k) is not None}
            elif t == "compaction":
                d["compactions"] += 1
                d["ribbon"].append((ts, "compaction"))
            elif t == "context_edit":
                d["context_edits"] += 1
            elif t == "model_change":
                d["model_changes"] += 1
            elif t == "custom":
                ct = o.get("customType") or o.get("name") or "unknown"
                d["om"][ct] = d["om"].get(ct, 0) + 1
            elif t == "custom_message":
                ct = o.get("customType") or ""
                if ct == "subagent-report":
                    content = o.get("content") or ""
                    m = REPORT_RE.match(content)
                    rep = {
                        "ts": ts,
                        "id": m.group(1).strip() if m else None,
                        "label": m.group(2).strip() if m else None,
                        "status": m.group(3) if m else None,
                        "chars": len(content),
                    }
                    d["sub_reports"].append(rep)
            elif t == "message":
                m = o.get("message")
                if not isinstance(m, dict):
                    continue
                role = m.get("role") or "unknown"
                d["roles"][role] = d["roles"].get(role, 0) + 1

                if role == "assistant":
                    content = m.get("content")
                    first_tool = None
                    has_text = False
                    n_calls = 0
                    calls = content if isinstance(content, list) else []
                    for c in calls:
                        if not isinstance(c, dict):
                            continue
                        ct = c.get("type")
                        if ct == "toolCall":
                            n_calls += 1
                            name = c.get("name") or "n/a"
                            cid = c.get("id")
                            sample = arg_sample(c.get("arguments"))
                            d["tool_calls"].append((ts, name, cid, sample))
                            d["tool_args"].setdefault(name, [])
                            if len(d["tool_args"][name]) < 3 and sample is not None:
                                d["tool_args"][name].append(sample)
                            if first_tool is None:
                                first_tool = name
                            if name in ("subagent_spawn", "subagent") and ts is not None:
                                d["spawn_ts"].append((ts, name))
                        elif ct == "text":
                            has_text = True
                    u = m.get("usage") if isinstance(m.get("usage"), dict) else {}
                    for k in usage:
                        v = u.get(k)
                        if isinstance(v, (int, float)):
                            usage[k][0] += v
                            usage[k][1] += 1
                    cost = u.get("cost")
                    if isinstance(cost, dict) and isinstance(cost.get("total"), (int, float)):
                        d["cost_total"][0] += cost["total"]
                        d["cost_total"][1] += 1
                    dur = m.get("durationMs")
                    d["assistant"].append({
                        "ts": ts,
                        "model": m.get("model"),
                        "provider": m.get("provider"),
                        "durationMs": dur if isinstance(dur, (int, float)) else None,
                        "usage": u,
                        "first_tool": first_tool,
                        "has_text": has_text,
                        "n_calls": n_calls,
                    })
                    if ts is not None:
                        d["ribbon"].append((ts, "assistant"))

                elif role == "toolResult":
                    name = m.get("toolName") or "n/a"
                    cid = m.get("toolCallId")
                    err = bool(m.get("isError"))
                    dur = m.get("durationMs")
                    d["tool_results"].append((ts, cid, name, err, dur if isinstance(dur, (int, float)) else None))
                    agg = d["tool_err_dur"].setdefault(name, [0, 0.0, 0])
                    if err:
                        agg[0] += 1
                    if isinstance(dur, (int, float)):
                        agg[1] += dur
                        agg[2] += 1
                    if ts is not None:
                        d["ribbon"].append((ts, "toolResult"))

                elif role in ("user", "system") and ts is not None:
                    d["ribbon"].append((ts, role))
    return d


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
h2{font-size:16px;margin:28px 0 8px;padding-left:9px;border-left:3px solid var(--blue)}
h2 .en{color:var(--mut);font-size:12px;font-weight:400;margin-left:8px}
.sub{color:var(--mut);font-size:12px;margin:2px 0 10px}
.mut{color:var(--mut)} .small{font-size:12px}
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


def build_html(session, cards, sub_dir, last_n, all_mode):
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

    kpis = [
        kpi_card("数据窗口", f"<small>{esc(win_txt)}</small>", wide=True,
                 extra=f"时长 {dur} · {esc(fname)}"),
        kpi_card("输入 tokens", esc(human_num(usage["input"][0] if usage["input"][1] else None))),
        kpi_card("缓存读 tokens", esc(human_num(usage["cacheRead"][0] if usage["cacheRead"][1] else None))),
        kpi_card("缓存写 tokens", esc(human_num(usage["cacheWrite"][0] if usage["cacheWrite"][1] else None))),
        kpi_card("输出 tokens", esc(human_num(usage["output"][0] if usage["output"][1] else None))),
        kpi_card("推理 tokens", esc(human_num(usage["reasoning"][0] if usage["reasoning"][1] else None))),
        kpi_card("累计成本",
                 esc(f"${session['cost_total'][0]:.4f}" if session["cost_total"][1] else None)),
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

    # ---- 工具调用 ----
    per_tool = {}
    for _ts, name, _cid, _s in session["tool_calls"]:
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
                                    "dur": 0.0, "dur_n": 0})
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
        if isinstance(m["durationMs"], (int, float)):
            e["dur"] += m["durationMs"]
            e["dur_n"] += 1
    if models:
        mrows = ["<tr><th>模型</th><th>响应</th><th>输入</th><th>输出</th><th>均耗时</th></tr>"]
        for name, e in sorted(models.items(), key=lambda kv: -kv[1]["n"]):
            mrows.append(
                f'<tr><td>{esc(name)}</td><td>{e["n"]}</td>'
                f'<td>{esc(human_num(e["in"] if e["in_n"] else None))}</td>'
                f'<td>{esc(human_num(e["out"] if e["out_n"] else None))}</td>'
                f'<td>{esc(human_dur(e["dur"] / e["dur_n"]) if e["dur_n"] else "n/a")}</td></tr>')
        model_html = (f'<div class="card tblwrap"><table>{"".join(mrows)}</table></div>'
                      f'<div class="sub small">输入/输出为 usage.input / usage.output 原始字段之和；'
                      f'缓存读写与推理 tokens 见顶部 KPI。</div>')
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
    footer = (f'pi_dashboard.py · generated {now_iso} · from <code>{esc(fname)}</code> '
              f'({session["parsed"]} events parsed, {session["skipped"]} skipped)'
              f'<br>匹配自检: toolCall {len(call_ids)} 个 id ↔ toolResult {len(res_ids)} 个 id，'
              f'匹配率 {esc(f"{match_rate * 100:.2f}%" if match_rate is not None else "n/a")}'
              f'<br>子代理目录 <code>{esc(os.path.abspath(sub_dir))}</code> · 所有数值均直接来自会话文件，缺失字段显示 n/a')

    title = f"Pi 活动仪表盘 · {esc(fname)}"
    parts = [
        "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">",
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f"<title>{title}</title>\n<style>{CSS}</style>\n</head>\n<body>\n<div class=\"wrap\">",
        f"<h1>Pi 会话活动仪表盘</h1>"
        f'<div class="sub">{meta_line}</div>',
        f'<div class="kpis">{"".join(kpis)}</div>',
        f'<h2>Token 流<span class="en">token flow</span></h2>'
        f'<div class="sub">{esc(win_note)} {esc(scale_note) if scale_note else ""}</div>'
        f'<div class="card">{flow_svg}</div>'
        f'<div class="legend">{legend}<span style="margin-left:auto">柱高 = 输入+缓存读+输出+推理（每条 assistant 消息）</span></div>'
        f'<div class="card" style="margin-top:10px">{cum_svg}</div>',
        f'<h2>工具调用<span class="en">tools</span></h2>'
        f'<div class="sub">条长 = 调用次数占比；条内红色段 = 错误占比（isError，按 toolCallId 关联 toolResult）。前 3 名工具附参数样本。</div>'
        f'<div class="card">{"".join(tool_rows)}</div>',
        f'<h2>子代理<span class="en">subagents</span></h2>'
        f'<div class="sub">时间线：○ spawn（subagent/subagent_spawn 调用） · '
        f'<i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f5a63b"></i> ready 报告 · '
        f'<i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#3fbf7f"></i> done 报告</div>'
        f'<div class="card">{tl_svg}</div>'
        f'<div class="sub small" style="margin-top:6px">{esc(sa_note)}</div>'
        f'<div class="sas">{sa_cards_html}</div>',
        f'<h2>模型<span class="en">models</span></h2>{model_html}',
        f'<h2>事件密度<span class="en">event ribbon</span></h2>'
        f'<div class="sub">每列 ≈ 一条消息，按会话顺序排列（>2500 条时按多数角色聚合）。悬停可看时间与角色。</div>'
        f'<div class="card">{ribbon_svg}</div><div class="legend">{rlegend}</div>',
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
    session = parse_session(path)
    cards = scan_subagents(a.subagents_dir, session, a.subagents_all)

    html_doc = build_html(session, cards, a.subagents_dir, max(1, a.last_n), a.subagents_all)
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

    cost_txt = (f"${session['cost_total'][0]:.4f}" if session["cost_total"][1] else "n/a")
    print(
        f"summary: file={os.path.basename(path)} events={session['parsed']} skipped={session['skipped']} | "
        f"tokens input={tk('input')} output={tk('output')} cacheRead={tk('cacheRead')} "
        f"cacheWrite={tk('cacheWrite')} reasoning={tk('reasoning')} cost_total={cost_txt}"
    )
    print(
        f"  messages={sum(roles.values())} (assistant={roles.get('assistant', 0)} "
        f"user={roles.get('user', 0)} toolResult={roles.get('toolResult', 0)} "
        f"system={roles.get('system', 0)}) | toolCalls={len(session['tool_calls'])} "
        f"toolResults={len(session['tool_results'])} matchRate={rate_txt} | "
        f"subagentReports={len(session['sub_reports'])} subagentDirs={len(cards)} | "
        f"compactions={session['compactions']}"
    )
    print(f"  out={a.out} ({os.path.getsize(a.out)} bytes) window="
          f"{fmt_day(session['t_first'])} → {fmt_day(session['t_last'])} UTC, "
          f"last_n={a.last_n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
