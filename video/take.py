#!/usr/bin/env python3
"""The Poppy demo take: the agent chat walks the Personal Agent Protocol in Real mode — the person asks the
agent, the agent discovers the Company, the person signs in on PingFederate's own page (CIMD; the password is
typed into the password field, which renders as dots), the agent exchanges and calls, and the sequence + reel
show every request. Adapted from the pf-privilege-obo take (same machinery: the shared overlay, the on-screen
host mask built from the lab's .env, the shared holds, two profiles, main/end segments).

Usage: python3 take.py <work_dir>
  work_dir gets: ready.json, go.flag (optional), take-<segment>.mp4, take.log
"""
import json, os, re, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
import base64
import captions, onscreen_mask
from story_bridge import overlay_script, slide_payload as _slide_payload, hold_bubble, hold_slide as _hold_slide
OPENING_SLIDE = CLOSING_SLIDE = STEPS = SLIDES = None
PUBLIC_IMAGES = None   # {captured name: redacted name}, filled in main() before the browser opens

WORK = Path(sys.argv[1] if len(sys.argv) > 1 else "take-work").resolve()
SEGMENT = os.environ.get("SEGMENT", "all")
PROFILE = os.environ.get("PROFILE", "monitor")
PROFILES = {"monitor": dict(monitor="medium", display=(1920, 1080), font="L", scale=1.3, dsf=1, video=(1920, 1080)),
            "laptop":  dict(monitor="laptop", display=(1800, 1169), font="S", scale=1.0, dsf=2, video=(1800, 1169))}
_prof = PROFILES[PROFILE]
FONT = os.environ.get("FONT", _prof["font"]); SCALE = float(os.environ.get("SCALE", _prof["scale"]))
MONITOR = os.environ.get("MONITOR", _prof["monitor"])
PRESETS = {"medium": {"origin": (-1920, -905), "win": (-1920, -905)}, "laptop": {"origin": (0, 0), "win": (0, 0)}}
_preset = PRESETS.get(MONITOR, PRESETS["medium"])
ORIGIN_X, ORIGIN_Y = int(os.environ.get("DISPLAY_X", _preset["origin"][0])), int(os.environ.get("DISPLAY_Y", _preset["origin"][1]))
WIN_X, WIN_Y = int(os.environ.get("WIN_X", _preset["win"][0])), int(os.environ.get("WIN_Y", _preset["win"][1]))
WIN_W, WIN_H = _prof["display"]
OUT_W = int(os.environ.get("OUT_W", 2400))
REHEARSE = os.environ.get("REHEARSE") == "1"
SAMPLE = os.environ.get("SAMPLE") == "1"
HEADLESS_REAL = os.environ.get("HEADLESS_REAL") == "1"
RECORD_PW = (SAMPLE or HEADLESS_REAL) and not REHEARSE
HEADLESS = REHEARSE or SAMPLE or HEADLESS_REAL
WAIT_GO = os.environ.get("WAIT_GO") == "1"
THEME = os.environ.get("THEME", "light")
APP = os.environ.get("APP_URL", "https://127.0.0.1:5451")
PFENV = Path(os.environ.get("PF_ENV", "/Users/cmuir/.config/demo-kit/poppy-verification-signin.env"))
def log(*a):
    WORK.mkdir(parents=True, exist_ok=True)
    print(*a, flush=True)

def clip_window(first, last, delay=0.05, tail=0.8):
    """Cut from just after the first slide is drawn to just after the closing slide has been held."""
    if first is None: return {"start": 0.0, "end": None}
    return {"start": round(first + delay, 2), "end": round(last + tail, 2) if last is not None else None}

def pf_creds():
    env = {}
    for line in PFENV.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1); env[k.strip()] = v.strip()
    return env.get("DEMO_USER", ""), env.get("DEMO_USER_PASSWORD", "")

def mask_config():
    """Hosts that must never show on screen, from the lab's .env (never written into the repo)."""
    path = Path(os.environ.get("PD_ENV_FILE") or (Path(__file__).resolve().parent.parent / ".env"))
    env = {}
    if path.exists():
        for line in path.read_text().splitlines():
            m = re.match(r"\s*([A-Za-z0-9_]+)\s*=\s*(.*)", line)
            if m and not line.lstrip().startswith("#"): env[m.group(1)] = m.group(2).strip().strip("'\"")
    named = {}
    for k, v in env.items():
        for h in re.findall(r"https?://([A-Za-z0-9.:-]+)", v):
            h = h.rstrip(":")
            if "." in h or ":" in h:
                ph = "pingfederate.example" if "ISSUER" in k else ("company.example" if "COMPANY" in k else "agent.example")
                named.setdefault(h.lower(), ph)
    rules = [[re.escape(h), ph] for h, ph in sorted(named.items(), key=lambda x: -len(x[0]))]
    domains = {".".join(h.split(":")[0].split(".")[-2:]) for h in named if "." in h}
    rules += [[r"(?:[A-Za-z0-9-]+\.)*" + re.escape(d) + "(?::[0-9]+)?", "host.example"] for d in sorted(domains)]
    leak = "|".join([re.escape(h) for h in named] + [re.escape(d) for d in domains])
    return {"rules": rules, "leak": leak, "hosts": len(named)}

MASK_JS = """(() => {
  const CFG = __CFG__;
  function walk(node) {
    if (node.nodeType === 3) {
      let t = node.textContent;
      for (const [pat, rep] of CFG.rules) t = t.replace(new RegExp(pat, 'g'), rep);
      if (t !== node.textContent) node.textContent = t;
      return;
    }
    for (const c of node.childNodes) walk(c);
    if (node.attributes) for (const a of node.attributes) {
      let v = a.value;
      for (const [pat, rep] of CFG.rules) v = v.replace(new RegExp(pat, 'g'), rep);
      if (v !== a.value) a.value = v;
    }
  }
  const start = () => { walk(document.body); new MutationObserver(() => walk(document.body)).observe(document.body, {childList: true, subtree: true, characterData: true}); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  window.__maskLeak = () => { const m = ((document.body && document.body.innerText) || '').match(new RegExp(CFG.leak, 'i')); return m ? m[0] : null; };
})();
"""

ASSETS = Path(__file__).parent / "assets"
def public_images(slides, rules, assets=ASSETS):
    """Every image any slide of this take can show, mapped to its OCR-checked redacted copy. Refuses before recording."""
    return {s["image"]: onscreen_mask.public_image(s["image"], assets, rules) for s in slides if s and s.get("image")}

def slide_payload(cfg):
    if cfg.get("image") and PUBLIC_IMAGES is not None:
        cfg = {**cfg, "image": PUBLIC_IMAGES.get(cfg["image"])}
    return _slide_payload(cfg, ASSETS)

def main():
    global OPENING_SLIDE, CLOSING_SLIDE, STEPS, SLIDES, MASK_SCRIPT, TOTAL
    WORK.mkdir(parents=True, exist_ok=True)
    try:
        OPENING_SLIDE, CLOSING_SLIDE, STEPS, SLIDES = captions.load(APP, Path(__file__).parent / "captions.md")
    except ValueError as e:
        log("cannot read the wording:", e); raise SystemExit(f"take.py: {e}")
    global PUBLIC_IMAGES
    rules = mask_config()["rules"]
    PUBLIC_IMAGES = public_images([OPENING_SLIDE, CLOSING_SLIDE, *SLIDES.values()], rules)   # before the browser opens: a bad copy stops the take now
    if PUBLIC_IMAGES: log("slide images: redacted copies checked by OCR:", len(PUBLIC_IMAGES))
    user, password = pf_creds()
    if not password: raise SystemExit("take.py: no demo-user credentials in " + str(PFENV))
    profile = tempfile.mkdtemp(prefix="pd-take-")
    (Path(profile) / "Default").mkdir(parents=True, exist_ok=True)
    (Path(profile) / "Default" / "Preferences").write_text(json.dumps({
        "credentials_enable_service": False, "credentials_enable_autosignin": False,
        "profile": {"password_manager_enabled": False}, "autofill": {"profile_enabled": False, "credit_card_enabled": False}}))
    result = {"ok": False}
    with sync_playwright() as pw:
        T0 = time.time(); MARK = {}
        ctx = pw.chromium.launch_persistent_context(
            profile, headless=HEADLESS, no_viewport=not HEADLESS, viewport={"width": WIN_W, "height": WIN_H} if HEADLESS else None,
            **({"device_scale_factor": _prof["dsf"]} if HEADLESS else {}),
            ignore_https_errors=True,
            **({"record_video_dir": str(WORK / "pw-video"), "record_video_size": {"width": WIN_W, "height": WIN_H}} if RECORD_PW else {}),
            args=[f"--window-position={WIN_X},{WIN_Y}", f"--window-size={WIN_W},{WIN_H}", "--no-first-run", "--no-default-browser-check", *([] if HEADLESS else ["--kiosk"])])
        ctx.add_init_script("window.__cmScale = " + json.dumps(SCALE) + ";")
        ctx.add_init_script(overlay_script())
        if not SAMPLE:
            _mask = mask_config(); log("host masking on:", _mask["hosts"], "hosts from the lab .env")
            ctx.add_init_script(MASK_JS.replace("__CFG__", json.dumps(_mask)))
            # The consent screen's Allow (PF's own consent page; the story's sign-in crossing)
            ctx.add_init_script("""
  setInterval(() => {
    const allow = document.querySelector('input[value="Allow"]') || [...document.querySelectorAll('button,a')].find((x) => (x.textContent || '').trim() === 'Allow');
    if (allow) allow.click();
  }, 700);""")
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(APP + "/"); page.wait_for_selector("[data-testid=story-toggle]")
        page.select_option("[data-testid=theme-select]", THEME)
        if not HEADLESS:
            subprocess.run(["osascript", "-e", 'tell application "System Events" to set frontmost of (first process whose name is "Google Chrome for Testing") to true'], capture_output=True)
        page.bring_to_front(); page.wait_for_timeout(1500 if HEADLESS else 4500)
        g = page.evaluate("() => ({screenX: window.screenX, screenY: window.screenY, outerW: window.outerWidth, outerH: window.outerHeight, innerW: window.innerWidth, innerH: window.innerHeight, dpr: window.devicePixelRatio})")
        dpr = g["dpr"] or 1
        g["crop"] = {"w": round(g["innerW"] * dpr), "h": round(g["innerH"] * dpr),
                     "x": round((g["screenX"] - ORIGIN_X) * dpr), "y": round((g["screenY"] - ORIGIN_Y + (g["outerH"] - g["innerH"])) * dpr)}
        (WORK / "ready.json").write_text(json.dumps(g)); log("ready", g)
        page.evaluate("o => window.__cm.cap(o)", dict(n=0, total=0, title="Test frame", text="This is the recording area. Nothing is being recorded yet.", target="[data-testid=story-toggle]"))
        if WAIT_GO:
            log("waiting for go.flag")
            while not (WORK / "go.flag").exists():
                if (WORK / "abort.flag").exists(): log("aborted"); ctx.close(); return
                time.sleep(0.5)
        else:
            page.wait_for_timeout(2000)
        page.evaluate("() => window.__cm.clear()")
        c = g["crop"]
        ff = None if HEADLESS else subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "avfoundation", "-framerate", "30", "-capture_cursor", "1",
                               "-pixel_format", "uyvy422", "-i", "1:none", "-vf", f"crop={c['w']}:{c['h']}:{c['x']}:{c['y']}" + (f",scale={OUT_W}:-2" if c["w"] > OUT_W else ""),
                               "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", "-t", "900", str(WORK / f"take-{SEGMENT}.mp4")],
                              stdin=subprocess.PIPE, stderr=open(WORK / "ffmpeg.log", "w"))
        log("rehearsal" if REHEARSE else "sample recording started (playwright)" if SAMPLE else "recording started"); time.sleep(0.2 if REHEARSE else 1.5)
        shots = os.environ.get("REHEARSE_SHOTS")
        count = {"n": 0}
        TOTAL = len(STEPS)
        def snap(name):
            if REHEARSE and shots:
                page.wait_for_timeout(300); Path(shots).mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(Path(shots) / f"{name}.png"))
        def check_leak(where):
            leak = page.evaluate("() => window.__maskLeak ? window.__maskLeak() : null")
            if leak: result.setdefault("host_leaks", []).append(where); log("HOST LEAK on screen at", where)
        def bubble(key, target=None, lines=None, secs=None, prefer=None, place=None):
            count["n"] += 1
            st = STEPS[key]
            page.evaluate("o => window.__cm.cap(o)", dict(n=count["n"], total=TOTAL, title=st["title"], text=st["text"], target=target, lines=lines, prefer=prefer, place=place))
            snap(f"step-{count['n']:02d}-{key}")
            check_leak(f"caption {count['n']} ({key})")
            page.wait_for_timeout(int((secs if secs is not None else hold_bubble(page, st["text"], lines)) * 1000 * (0.04 if REHEARSE else 1)))
        clip = {"first": None, "last": None}
        clock0 = time.monotonic()
        def show_slide(cfg, extra=0.0, name="slide", cap=30.0):
            if clip["first"] is None: clip["first"] = time.monotonic() - clock0
            MARK.setdefault("first", time.time())
            payload = slide_payload(cfg)
            page.evaluate("o => window.__cm.slide(o)", payload)
            snap(name)
            check_leak(name)
            total_ms = int(_hold_slide(page, payload) * 1000 * (0.04 if REHEARSE else 1))
            pre_ms = min(6000, int(total_ms * 0.45))
            page.wait_for_timeout(pre_ms)
            page.evaluate("() => window.__cm.scrollSlide()")
            page.wait_for_timeout(max(0, total_ms - pre_ms))
            page.evaluate("() => window.__cm.clear()")
            if name == "closing": clip["last"] = time.monotonic() - clock0
        def sign_pf():
            """The person signs in on PingFederate's own page: the password is typed into the password field
            (it renders as dots, never readable); the consent Allow click is the init script."""
            page.wait_for_selector('input[name="pf.pass"]', timeout=45000)
            page.wait_for_function('!document.querySelector(\'input[name="pf.pass"]\').disabled', timeout=30000)
            page.wait_for_timeout(900)
            page.fill('input[name="pf.pass"]', password)   # the username arrives prefilled (login_hint) and its field renders disabled — fill only the password
            snap("pf-signin")
            check_leak("pf sign-in page")
            for cand in ("role=button[name='Sign On']", "button:has-text('Sign On')", "input[value='Sign On']"):
                if page.locator(cand).count(): page.locator(cand).first.click(); break
            else: page.press('input[name="pf.pass"]', "Enter")
            # consent Allow is clicked by the init script; wait for the return (navigations abort waits — retry)
            import playwright._impl._errors as pwerr
            for _ in range(5):
                try:
                    page.wait_for_url("**/#chat**", timeout=60000); break
                except pwerr.Error:
                    if "#chat" in page.url: break
                    if "5451" in page.url and "signin" in page.url: break
            page.wait_for_selector("[data-testid=story-toggle]", timeout=20000); page.wait_for_timeout(1200)

        try:
            if SEGMENT in ("all", "main"):
                if SAMPLE: show_slide(SLIDES.get("sample_note", SLIDES.get("mock_note")), extra=2.0, name="sample_note", cap=22.0)
                show_slide(OPENING_SLIDE, extra=4.0, name="opening", cap=36.0)
                info = page.evaluate("fetch('/api/info').then(r => r.json())")
                if info.get("source") != "real" and not SAMPLE:
                    raise RuntimeError(f"the take needs Real mode (the lab says {info.get('source')!r})")
                page.goto(APP + "/"); page.wait_for_selector("[data-testid=story-toggle]", timeout=30000)
                page.select_option("[data-testid=theme-select]", THEME)
                page.evaluate("px => { document.documentElement.style.fontSize = px; }", {"S": "14px", "M": "16px", "L": "18px"}[FONT])
                page.wait_for_timeout(1000)
                # ===================== the chat: discover -> sign in -> token -> call =====================
                page.click('#tab-chat'); page.wait_for_selector("[data-testid=atlas-chat]", timeout=20000)
                page.wait_for_timeout(600)
                bubble("chat_intro", ".atlas-phone__head", prefer="below")
                # the discover chip
                page.wait_for_selector("[data-testid=atlas-chip-0]:not([disabled])", timeout=20000)
                bubble("chat_discover_prompt", "[data-testid=atlas-chip-0]", prefer="below")
                page.evaluate("() => window.__cm.clear()")
                page.click("[data-testid=atlas-chip-0]")
                page.wait_for_selector('[data-testid=atlas-step-discover]', timeout=30000); page.wait_for_timeout(900)
                bubble("chat_discover", '[data-testid=atlas-step-discover]', prefer="below")
                # the sign-in chip -> PingFederate's own page -> the person signs in -> return
                page.wait_for_selector("[data-testid=atlas-chip-0]:not([disabled])", timeout=20000)
                bubble("chat_signin_prompt", "[data-testid=atlas-chip-0]", prefer="below")
                page.evaluate("() => window.__cm.clear()")
                page.click("[data-testid=atlas-chip-0]")
                sign_pf()
                count["n"] += 1
                st = STEPS["chat_signin"]
                page.evaluate("o => window.__cm.cap(o)", dict(n=count["n"], total=TOTAL, title=st["title"], text=st["text"], target='[data-testid=atlas-step-authorize]', prefer="below"))
                snap("step-signin-return"); check_leak("sign-in return")
                page.wait_for_timeout(int(hold_bubble(page, st["text"], None) * 1000))
                page.wait_for_selector('[data-testid=atlas-step-token]', timeout=30000); page.wait_for_timeout(700)
                bubble("chat_token", '[data-testid=atlas-step-token]', prefer="below")
                # the last ask
                page.wait_for_selector("[data-testid=atlas-chip-0]:not([disabled])", timeout=20000)
                bubble("chat_call", "[data-testid=atlas-chip-0]", prefer="below")
                page.evaluate("() => window.__cm.clear()")
                page.click("[data-testid=atlas-chip-0]")
                page.wait_for_selector('[data-testid=atlas-step-call]', timeout=30000); page.wait_for_timeout(900)
                if page.locator('[data-testid=sequence-view]').count():
                    bubble("chat_done", '[data-testid=sequence-view]', prefer="below")
                else:
                    bubble("chat_done", '[data-testid=atlas-step-call]', prefer="below")
                result["main_ok"] = True
            if SEGMENT in ("all", "end"):
                if SEGMENT == "end":
                    page.goto(APP + "/"); page.wait_for_selector("[data-testid=story-toggle]", timeout=30000)
                    page.select_option("[data-testid=theme-select]", THEME)
                show_slide(CLOSING_SLIDE, extra=3.0, name="closing", cap=36.0)
                result["end_ok"] = True
            result["clip"] = clip_window(clip["first"], clip["last"]); log("clip window (s):", result["clip"])
            result["ok"] = all(v for k, v in result.items() if k.endswith("_ok")) and not result.get("host_leaks")
            log("RESULT", json.dumps(result))
        finally:
            if ff:
                try: ff.send_signal("SIGINT"); ff.wait(timeout=15)
                except Exception: ff.kill()
        vpath = page.video.path() if RECORD_PW and page.video else None
        ctx.close()
        if vpath:
            out = WORK / ("sample.mp4" if SAMPLE else "take-headless.mp4")
            w = result["clip"]; cut = ["-ss", str(w["start"])] + (["-t", str(round(w["end"] - w["start"], 2))] if w["end"] is not None else [])
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *cut, "-i", str(vpath), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", str(out)], check=True)
            log("video:", out)
    (WORK / "result.json").write_text(json.dumps(result, indent=1))
    return result

if __name__ == "__main__":
    r = main()
    sys.exit(0 if r and r.get("ok") else 1)
