---
name: vultr-vps-ops
description: Operate the Vultr VPS account (API balance/billing reads, ACL whitelist pitfalls) and the shadowsocks-rust jump box it hosts, plus the local mihomo TUN client. Use for Vultr billing questions, 401 "Unauthorized IP" errors, instance migration/reinstall with the SS service, proxy-stall (TUN mtu) debugging, or IP changes. Credentials live in ~/.config/vultr/; grants no new spend or instance-deletion authorization.
---

# Vultr VPS + shadowsocks/mihomo operations

## 1. API essentials

- API token: `~/.config/vultr/token` (mode 0600). Example:
  `curl -sS -H "Authorization: Bearer $(cat ~/.config/vultr/token)" https://api.vultr.com/v2/account`
- **Balance sign convention** (misread once, cost the user a wasted billing audit):
  `balance ≤ 0` = HEALTHY — negative means prepaid credit; `balance > 0` = actually owed.
  After a $10 top-up the balance shows `-$10`. Do NOT read negative as debt.
- Other read-only calls (same header): `.../v2/billing/history` and `.../v2/instances` (list).
- Cross-check in `/v2/billing/history`: an entry with `type=payment` and a NEGATIVE amount is a
  top-up being CREDITED, not a charge.
- VPS sizing: `vc2-1c-2gb` ($10/月) is ample for a shadowsocks jump box; the expensive `vx1-g` tier
  is frequently out of stock in lax/sjc.

## 2. ACL whitelist trap (401 Unauthorized IP)

- Symptom: API returns `401 {"error":"Unauthorized IP address: <ip>"}` while the token is valid.
- First identify your actual egress IP: `curl -sS https://ifconfig.me` — with TUN on it returns the
  proxy exit node, not your home IP. Compare it with the IP in the error message before touching the
  whitelist.
- Cause: Vultr Access Control matches the SOURCE (egress) IP. With TUN/global proxy on, ALL requests
  leave via the proxy exit node, not the home IP — so a whitelist containing your home IP rejects
  every call.
- Action: change the whitelist in the Vultr WEB CONSOLE only — the API cannot modify its own ACL
  (chicken-and-egg). With a dynamic home IP, clear the whitelist (empty = allow all) instead of
  chasing IP drift; keep the token itself as the gate.

## 3. Migration / reinstall runbook (SS jump box)

- Snapshot restore requires the target disk ≥ the source disk. Downsizing (e.g. 120G → 55G) CANNOT
  go through a snapshot — do a fresh install instead.
- Reinstall path (measured ~2 minutes of setup):
  1. Deploy/reinstall on `vc2-1c-2gb`, pick the OS, note the new IP.
  2. Install shadowsocks-rust: ONE JSON config + a systemd unit + UFW rules.
     Server config backup: `~/.config/vultr/ss-config-backup.json`
     (keys: server / server_port=52079 / password / timeout / mode=tcp_and_udp / method=aes-128-gcm).
  3. UFW: allow 22 + 52079; enable ufw.
  4. Verify listening: `ss -tlnp | grep 52079` (and `systemctl status shadowsocks-rust`).

## 4. Client side — mihomo (local Mac)

- Config: `/opt/homebrew/etc/mihomo/config.yaml` (brew-managed). Client SS config:
  `~/.config/shadowsocks.json`.
- **TUN must set `mtu: 1500` explicitly.** Default 9000 causes big-transfer stalls: small packets
  fine, large files crawl at KB/s. Symptom→fix: slow bulk downloads only → set mtu 1500, restart.
- `dns.fallback`: foreign DoH servers (1.1.1.1 / 8.8.8.8) MUST carry a `#PROXY` suffix so fallback
  queries go through the proxy. Direct DoH is blocked; symptom: "resolve timeout" on proxied domains.
- brew services installs per-user AND root instances — the two fight over port 7890. Keep ONLY the
  root-level one (LaunchDaemon): TUN needs root. `sudo brew services list` vs `brew services list`.
- `tcp-concurrent` does not beat physics: on the ~183 ms LAX link (vs 894 ms Atlanta) config tweaks
  give no perceptible speedup; don't chase it, choose region by RTT.

## 5. IP-change checklist (after any new IP)

1. `~/.config/shadowsocks.json` → `server` field.
2. mihomo `proxies:` section server field in `/opt/homebrew/etc/mihomo/config.yaml`.
3. Vultr console ACL whitelist — re-evaluate (see §2; empty whitelist survives IP changes best).
4. Restart ss client + mihomo, then verify: `curl -x socks5h://127.0.0.1:1080 https://ifconfig.me`
   (expect the new IP) and a bulk download through TUN.

## Source

knowledge-base/daily/2026-11-05.md (Vultr/代理体系迁移段); `~/.config/vultr/` (token,
ss-config-backup.json); mihomo config `/opt/homebrew/etc/mihomo/config.yaml`.
