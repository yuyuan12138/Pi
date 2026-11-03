#!/usr/bin/env python3
"""Read a WPS 365 cloud spreadsheet via a CDP-driven Chrome (zero deps).

Requires a Chrome instance launched with --remote-debugging-port=9222 and a
profile logged into WPS (see launch_chrome.sh). Reads the currently-open
spreadsheet, or navigates to a given kdocs.cn link first.

Usage:
  python3 wps_read.py                     # read the currently-open sheet -> JSON to stdout
  python3 wps_read.py --url <kdocs link>  # navigate then read
  python3 wps_read.py --csv OUTDIR        # also write one CSV per sheet
  python3 wps_read.py --sheet 流水-轩      # read only the named sheet(s)
  python3 wps_read.py --max-rows 200      # cap rows per sheet (default: all)
"""
import base64, json, os, socket, struct, sys, time, urllib.request, csv

CDP_PORT = int(os.environ.get("CDP_PORT", "9222"))

def http_json(path):
    with urllib.request.urlopen(f"http://localhost:{CDP_PORT}{path}", timeout=10) as r:
        return json.load(r)

class CDP:
    def __init__(self, ws_url):
        hostport, path = ws_url[5:].split("/", 1)
        host, port = hostport.split(":")
        self.sock = socket.create_connection((host, int(port)), timeout=60)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        if b"101" not in buf.split(b"\r\n")[0]:
            raise RuntimeError("ws handshake failed: " + buf.decode(errors="replace")[:200])
        self._id = 0; self._buf = buf.split(b"\r\n\r\n", 1)[1]
    def _recv(self, n):
        while len(self._buf) < n:
            c = self.sock.recv(65536)
            if not c: raise RuntimeError("socket closed")
            self._buf += c
        o, self._buf = self._buf[:n], self._buf[n:]; return o
    def _frame(self):
        b0, b1 = self._recv(2); op = b0 & 0x0f; masked = b1 & 0x80; ln = b1 & 0x7f
        if ln == 126: ln = struct.unpack(">H", self._recv(2))[0]
        elif ln == 127: ln = struct.unpack(">Q", self._recv(8))[0]
        mk = self._recv(4) if masked else None; pl = self._recv(ln)
        if mk: pl = bytes(b ^ mk[i % 4] for i, b in enumerate(pl))
        return op, pl
    def _send(self, data, op=1):
        ln = len(data); h = bytes([0x80 | op]); mk = os.urandom(4)
        if ln < 126: h += bytes([0x80 | ln])
        elif ln < 65536: h += bytes([0x80 | 126]) + struct.pack(">H", ln)
        else: h += bytes([0x80 | 127]) + struct.pack(">Q", ln)
        self.sock.sendall(h + mk + bytes(b ^ mk[i % 4] for i, b in enumerate(data)))
    def send(self, method, params=None):
        self._id += 1; mid = self._id
        self._send(json.dumps({"id": mid, "method": method, "params": params or {}}).encode())
        while True:
            op, pl = self._frame()
            if op == 8: raise RuntimeError("closed")
            if op != 1: continue
            m = json.loads(pl.decode())
            if m.get("id") == mid:
                if "error" in m: raise RuntimeError(method + ": " + json.dumps(m["error"])[:300])
                return m.get("result", {})
    def evaluate(self, expr, await_promise=False):
        r = self.send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": await_promise})
        if "exceptionDetails" in r: return {"__exception__": str(r["exceptionDetails"])[:400]}
        return r.get("result", {}).get("value")
    def navigate(self, url):
        self.send("Page.navigate", {"url": url})
    def close(self):
        try: self.sock.close()
        except Exception: pass

READ_JS = r'''(async function(opts){
  function P(t){ return new Promise(function(res,rej){ if(t&&typeof t.then==='function') t.then(res,rej); else res(t); }); }
  function conv(v){ if(typeof v==='number' && isFinite(v) && v>59 && v<200000){ var d=new Date(Math.round((v-25569)*86400*1000)); return d.toISOString().slice(0,10); } return v; }
  var out={url:location.href, title:document.title, sheets:[]};
  try{
    var et=await P(window.WPSOpenApi.EtApplication());
    var ws=await P(et.Worksheets);
    var count=await P(ws.Count);
    for(var i=1;i<=count;i++){
      var sh=await P(ws.Item(i));
      var nm=await P(sh.Name);
      if(opts.sheets && opts.sheets.length && opts.sheets.indexOf(nm)<0) continue;
      var ur=await P(sh.UsedRange);
      var R=await P(ur.Rows.Count), C=await P(ur.Columns.Count);
      var cap=Math.min(R, opts.maxRows);
      var val=await P(ur.Resize(cap, C).Value);
      if(!val || !val.length) val=[[]];
      var rows=val.map(function(r){ return (r||[]).map(conv); });
      out.sheets.push({name:nm, totalRows:R, totalCols:C, returnedRows:rows.length, rows:rows});
    }
    out.ok=true;
  }catch(e){ out.ok=false; out.error=String(e); out.stack=(e&&e.stack||'').slice(0,300); }
  return JSON.stringify(out);
})('''

def main():
    args = sys.argv[1:]
    url = None; csvdir = None; sheets = []; max_rows = 100000
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--url": url = args[i+1]; i += 2
        elif a == "--csv": csvdir = args[i+1]; i += 2
        elif a == "--sheet": sheets.append(args[i+1]); i += 2
        elif a == "--max-rows": max_rows = int(args[i+1]); i += 2
        else: i += 1
    pages = [t for t in http_json("/json") if t.get("type") == "page"]
    if not pages: print(json.dumps({"error": "no CDP page target; launch Chrome first"})); return
    c = CDP(pages[0]["webSocketDebuggerUrl"])
    if url:
        c.navigate(url); time.sleep(8)
    # detect login wall
    body = c.evaluate("(function(){return (document.body?document.body.innerText:'').slice(0,300);})()")
    if body and ("sign in" in body.lower() or "登录" in body or "需要登录" in body):
        print(json.dumps({"status": "login_required", "hint": "log into WPS in the CDP Chrome window, then rerun", "body": body}, ensure_ascii=False))
        c.close(); return
    opts = {"sheets": sheets, "maxRows": max_rows}
    raw = c.evaluate(READ_JS + json.dumps(opts) + ")", await_promise=True)
    data = json.loads(raw) if isinstance(raw, str) else raw
    if not data.get("ok"):
        print(json.dumps({"error": "read failed", "detail": data}, ensure_ascii=False)); c.close(); return
    if csvdir:
        os.makedirs(csvdir, exist_ok=True)
        for s in data["sheets"]:
            safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in s["name"])
            p = os.path.join(csvdir, safe + ".csv")
            with open(p, "w", newline="", encoding="utf-8") as f:
                w = csv.writer(f); w.writerows(s["rows"])
            s["csv"] = p
    print(json.dumps(data, ensure_ascii=False))
    c.close()

if __name__ == "__main__":
    main()