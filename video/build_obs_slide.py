#!/usr/bin/env python3
"""Builds assets/observability.json (the observability slide) from the lab's own run-observability records that take.py saved in result.json
for the run it recorded (SEGMENT=main). Nothing here is typed by hand: every line is a row the lab's panel showed, with its exact timestamp and
its origin tag (logged / response / simulated). A layer with no row is named as not logged, never filled in.

Usage: python3 video/build_obs_slide.py <take-work-dir>      (reads <dir>/result.json, writes video/assets/observability.json)
"""
import json, re, subprocess, sys
from pathlib import Path

work = Path(sys.argv[1])
result = json.loads((work / "result.json").read_text())
obs = result.get("obs") or {}
LAYER = {"person": "person", "agent": "agent", "authorize": "Authorize", "privilege": "Privilege", "gateway": "gateway", "resource": "MCP server"}
TAG = {"logged": "logged", "response": "response", "simulated": "simulated"}

def rows(name):
    rec = (obs.get(name) or {}).get("record")
    if not rec: raise SystemExit(f"observability record {name!r} is missing from result.json: {json.dumps(obs.get(name))[:160]}")
    if rec.get("source") != "real": raise SystemExit(f"record {name!r} is {rec.get('source')!r}, not a real run: refusing to build the slide")
    return rec

def hhmmss(r):
    t = r.get("atExact") or r.get("at") or ""
    return t[11:23] if len(t) >= 23 else t[11:19]

def line(r):
    msg = r["message"]
    msg = msg if len(msg) <= 72 else msg[:msg.rfind(" ", 0, 69)] + " ..."   # cut at a word, never mid-word
    return f'{hhmmss(r)}  {r.get("label") or LAYER.get(r["layer"], r["layer"])}  [{TAG.get(r["origin"], r["origin"])}]  {msg}'

def pick(rec, outcomes, limit):
    rs = [r for r in rec["rows"] if r["origin"] != "not-logged" and r["outcome"] in outcomes]
    # a logged row first (it is the product's own line), then the replies the lab holds; at most `limit`
    rs.sort(key=lambda r: (r["origin"] != "logged", r["at"]))
    return rs[:limit]

allowed, p2ref, p1blk = rows("part2_allowed"), rows("part2_refused"), rows("part1_blocked")

# The lab's own stdout lines for this take, read from the container's log on this machine (read-only `docker logs`, over the take's time window; no change to any container).
LAB_LINE = re.compile(r"^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) privilege-a2a-lab decision mode=real run=([a-f0-9-]{36}) actor=([a-z0-9_-]{1,40}) target=([a-z0-9_-]{1,40}) result=(passed|stopped|blocked)$")
OUTCOME = {"passed": "allowed", "stopped": "refused", "blocked": "blocked"}
def lab_log_rows():
    since, until = result["started_utc"], result.get("finished_utc") or result["started_utc"]
    p = subprocess.run(["docker", "logs", "--since", since, "--until", until, "privilege-a2a-anthropic-demo-lab-main-1"], capture_output=True, text=True, timeout=60)
    rs = []
    for raw in (p.stdout + p.stderr).splitlines():
        m = LAB_LINE.match(raw.strip())
        if not m: continue
        at, run, actor, target, res = m.groups()
        rs.append({"at": at, "atExact": at, "layer": "gateway", "origin": "logged", "outcome": OUTCOME[res], "product": "privilege-a2a-lab",
                   "label": "lab log", "message": f"{actor} to {target}: {res}"})
    return rs
LAB = lab_log_rows()
print("lab log lines read from the container:", len(LAB))
def firsts(rs, n): return rs[:n]
lab_ok = [r for r in LAB if r["outcome"] == "allowed"]
lab_stop = [r for r in LAB if r["outcome"] in ("refused", "blocked")]
col_a = [line(r) for r in firsts(lab_ok, 1) + firsts(lab_ok[-1:], 1) + pick(allowed, {"allowed"}, 9)[-1:]]
col_b = [line(r) for r in firsts(lab_stop, 2) + pick(p2ref, {"refused", "blocked"}, 1)]
if not col_a: col_a = ["No allowed row was recorded for this run (the layers below say why)."]
if not col_b: col_b = ["No refused or blocked row was recorded for this run (the layers below say why)."]

# What was NOT logged, from the coverage of the refused run: said plainly, never implied.
cov = p2ref["coverage"]
missing = [LAYER[l] for l in LAYER if cov.get(l) in ("not-logged", "unreachable")]
# True only when a product's own log (not the lab's own line) had a refused or blocked row for the refused or blocked runs.
product_refusal = any(r["origin"] == "logged" and r["product"] != "privilege-a2a-lab" and r["outcome"] in ("refused", "blocked")
                      for rec in (p2ref, p1blk) for r in rec["rows"])
verdict = ("Excerpt, ids masked, times UTC. " +
           (f"Not logged or not readable here: {', '.join(missing)}. " if missing else "") +
           ("" if product_refusal else "No refusal line from the gateway's own log. ") +
           "Logs can stream to a SIEM (Ping's docs).")
out = {"lead": "This run's own log lines and the replies it recorded, read straight after the recording.",
       "col_a_heading": "Allowed", "col_a_lines": col_a,
       "col_b_heading": "Refused and blocked", "col_b_lines": col_b,
       "verdict": verdict}
dest = Path(__file__).parent / "assets" / "observability.json"
dest.write_text(json.dumps(out, indent=1))
print("wrote", dest)
print(json.dumps(out, indent=1))
