#!/usr/bin/env python3
"""Append multiple bookkeeping entries to 流水-钧 in one CDP session.

Usage: python3 batch_add.py entries.json
entries.json: [{"date":"2026-11-01","category":"零食","amount":9.9,"note":"新佳宜"}, ...]
"""
import json, sys, datetime
sys.path.insert(0, "/Users/yuyuan/PiAgents/tools/wps-reader")
from wps_read import CDP, http_json

SHEET_INDEX = 4
def excel_serial(s):
    y, m, d = map(int, s.split("-")); return (datetime.date(y, m, d) - datetime.date(1899, 12, 30)).days

JS = r'''(async function(entries){
  function P(t){ return new Promise(function(res,rej){ if(t&&typeof t.then==='function') t.then(res,rej); else res(t); }); }
  var out={written:[]};
  try{
    var et=await P(window.WPSOpenApi.EtApplication());
    var ws=await P(et.Worksheets);
    var sh=await P(ws.Item(__IDX__));
    var R=await P(sh.UsedRange.Rows.Count);
    var all=await P(sh.Range(sh.Cells(1,1),sh.Cells(R,4)).Value);
    var last=0; (all||[]).forEach(function(r,i){ if((r||[]).some(function(v){return v!==''&&v!==null&&v!==undefined&&v!=='null';})) last=i+1; });
    for(var i=0;i<entries.length;i++){
      var e=entries[i]; var row=last+1+i;
      sh.Cells(row,1).Value=e.date; sh.Cells(row,2).Value=e.category;
      sh.Cells(row,3).Value=e.amount; sh.Cells(row,4).Value=e.note||'';
      out.written.push({row:row, date:e.date, category:e.category, amount:e.amount, note:e.note||''});
    }
    await P(window.WPSOpenApi.save());
    var first=last+1, finalRow=last+entries.length;
    out.readback=await P(sh.Range(sh.Cells(first,1),sh.Cells(finalRow,4)).Value);
    out.ok=true;
  }catch(e){ out.ok=false; out.error=String(e); out.stack=(e&&e.stack||'').slice(0,300); }
  return JSON.stringify(out);
})('''

def main():
    entries = json.load(open(sys.argv[1], encoding="utf-8"))
    for e in entries:
        e["date"] = excel_serial(e["date"])
    pages = [t for t in http_json("/json") if t.get("type") == "page"]
    c = CDP(pages[0]["webSocketDebuggerUrl"])
    raw = c.evaluate(JS.replace("__IDX__", str(SHEET_INDEX)) + json.dumps(entries) + ")", await_promise=True)
    d = json.loads(raw) if isinstance(raw, str) else raw
    print(json.dumps(d, ensure_ascii=False, indent=1))
    c.close()

if __name__ == "__main__":
    main()