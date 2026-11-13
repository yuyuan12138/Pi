#!/usr/bin/env python3
"""Append a bookkeeping entry to the 流水-钧 sheet of the open WPS cloud sheet.

Usage:
  python3 add_entry.py --amount 25 --category 餐饮 --note "午饭" [--date 2026-11-03]
  python3 add_entry.py --amount 15 --category 交通 --note "打车去学校" --date 2026-11-02

Date defaults to today. Date is written as an Excel serial number to match the
sheet's existing date column. Appends at the first empty row after the last
data row of 流水-钧 (sheet index 4). Saves after writing.
"""
import json, sys, datetime
sys.path.insert(0, "/Users/yuyuan/PiAgents/tools/wps-reader")
from wps_read import CDP, http_json
from dispatch_guard import guard_write

SHEET_INDEX = 4  # 流水-钧

def excel_serial(y, m, d):
    return (datetime.date(y, m, d) - datetime.date(1899, 12, 30)).days

JS = r'''(async function(entry){
  function P(t){ return new Promise(function(res,rej){ if(t&&typeof t.then==='function') t.then(res,rej); else res(t); }); }
  var out={};
  try{
    var et=await P(window.WPSOpenApi.EtApplication());
    var ws=await P(et.Worksheets);
    var sh=await P(ws.Item(__IDX__));
    var R=await P(sh.UsedRange.Rows.Count);
    var all=await P(sh.Range(sh.Cells(1,1),sh.Cells(R,4)).Value);
    var last=0; (all||[]).forEach(function(r,i){ if((r||[]).some(function(v){return v!==''&&v!==null&&v!==undefined&&v!=='null';})) last=i+1; });
    var target=last+1;
    sh.Cells(target,1).Value=entry.date;     // Excel serial
    sh.Cells(target,2).Value=entry.category;
    sh.Cells(target,3).Value=entry.amount;
    sh.Cells(target,4).Value=entry.note||'';
    await P(window.WPSOpenApi.save());
    out.writtenRow=target;
    out.readback=await P(sh.Range(sh.Cells(target,1),sh.Cells(target,4)).Value);
    out.ok=true;
  }catch(e){ out.ok=false; out.error=String(e); out.stack=(e&&e.stack||'').slice(0,300); }
  return JSON.stringify(out);
})('''

def main():
    guard_write("add_entry.py")  # user-data write: refuse unless dispatched
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--amount", required=True, type=float)
    p.add_argument("--category", required=True)
    p.add_argument("--note", default="")
    p.add_argument("--date", default=None, help="YYYY-MM-DD, default today")
    a = p.parse_args()
    if a.date:
        y, m, d = map(int, a.date.split("-"))
    else:
        t = datetime.date.today(); y, m, d = t.year, t.month, t.day
    entry = {"date": excel_serial(y, m, d), "category": a.category, "amount": a.amount, "note": a.note}
    pages = [t for t in http_json("/json") if t.get("type") == "page"]
    c = CDP(pages[0]["webSocketDebuggerUrl"])
    raw = c.evaluate(JS.replace("__IDX__", str(SHEET_INDEX)) + json.dumps(entry) + ")", await_promise=True)
    d = json.loads(raw) if isinstance(raw, str) else raw
    print(json.dumps(d, ensure_ascii=False))
    c.close()

if __name__ == "__main__":
    main()