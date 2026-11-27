#!/usr/bin/env python3
"""Tests for the public-video masking. Run: python3 video/test_onscreen_mask.py  (the browser checks run where Playwright and Chromium are installed).
Every host here is under the reserved .invalid name (the lab's rule), so the rules are built with allow_reserved=True."""
import re, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import onscreen_mask as om

ENV = """# test values only
ANTHROPIC_BASE_URL=https://gw-lb.corp.invalid/llm/anthropic
WORKER_A2A_URL="https://gw-lb.corp.invalid/worker/a2a"  # quoted, then a comment
export AWS_AGENT_A2A_URL=https://gw-node2.corp.invalid/aws-agent-worker
AWS_AGENT_PF_TOKEN_URL=`https://someone-pf.corp.invalid/as/token.oauth2`
AWS_AGENT_PF_CLIENT_ID="demo-client-pass" # the PF client
AWS_AGENT_CUSTODIAN=Owner Person
LAB_ALLOWED_HOSTS=box1.priv.invalid,box2.priv.invalid
ALLOWED_ORIGINS=https://a.corp.invalid,https://b.other.invalid
WORKER_TRACE_URL=${BASE}https://gw-node4.corp.invalid/trace
SHELF_URL=http://localhost:8443/shelf
EMPTY_VALUE=
QUOTED_EMPTY=""
MCP_URL=http://192.168.1.10:6883/mcp
"""
PAGE = ("POST https://gw-lb.corp.invalid/worker/a2a/jsonrpc | iss https://someone-pf.corp.invalid | aud https://gw-node2.corp.invalid/aws-agent-worker "
        "| client_id demo-client-pass | https://gw-node3.corp.invalid/x | /runtimes/Real_Runtime-abc123/invocations | http://localhost:8443 ok "
        "| sibling cmuir-gw-lb.corp.invalid | bare https://corp.invalid/ | mail owner.name@corp.invalid | custodian Owner Person "
        "| Host box1.priv.invalid not allowed | origin https://b.other.invalid | trace https://gw-node4.corp.invalid/trace "
        "| arn:aws:bedrock-agentcore:us-east-1:xxxxxxxxxxxx:runtime/Real_Runtime-abc123 | esc https:\\/\\/x\\/runtimes\\/Real_Runtime-abc123\\/inv "
        "| enc resource=https%3A%2F%2Fgw-lb.corp.invalid%2Fruntimes%2Farn%253Aaws%253Aruntime%252FReal_Runtime-abc123%2Finv "
        "| hint=owner.name%40corp.invalid | version 2.1.10 | ip 192.168.1.10 | Authorization: Bearer sk-orion-ab12… (masked)")
REAL = ("corp.invalid", "priv.invalid", "other.invalid", "someone-pf", "gw-lb", "gw-node", "cmuir", "owner.name", "Owner Person", "demo-client-pass",
        "Real_Runtime-abc123", "box1", "sk-orion-ab12")

def build(text, allow=True):
    d = tempfile.TemporaryDirectory(); env = Path(d.name) / ".env"; env.write_text(text)
    try: return om.mask_rules(env, allow_reserved=allow)
    finally: d.cleanup()

def apply(text, rules):
    for p, r in rules["pairs"]: text = re.sub(p, r, text, flags=re.I)
    return text

def leaks(text, rules): return sum(len(re.findall(p, text, flags=re.I)) for p in rules["detect"])

class Rules(unittest.TestCase):
    def setUp(self): self.rules = build(ENV)

    def test_every_real_value_is_hidden_in_every_form_and_harmless_text_is_untouched(self):
        out = apply(PAGE, self.rules)
        for real in REAL: self.assertNotIn(real, out, real)
        for want in ("https://gateway.example/worker/a2a/jsonrpc", "iss https://pingfederate.example", "client_id aws-agent-client", "custodian the custodian",
                     "/runtimes/my-agent-runtime/invocations", "http://localhost:8443", "sibling host.example", "bare https://host.example/",
                     "someone@example.com", ":runtime/my-agent-runtime", "\\/runtimes\\/my-agent-runtime\\/", "version 2.1.10", "ip 192.168.1.10"):
            self.assertIn(want, out, want)
        self.assertEqual(leaks(out, self.rules), 0)
        self.assertEqual(apply(out, self.rules), out, 'masking twice changes nothing (the observer may see a node again)')

    def test_a_masked_key_still_shows_real_characters_so_only_its_prefix_is_kept(self):
        out = apply("Authorization: Bearer sk-orion-ab12… (masked) | also sk-ant-api03abcd and the word task-force-alpha, risk-based-plan, ask-me-anything", self.rules)
        self.assertEqual(out, "Authorization: Bearer sk-orion-xxxx… (masked) | also sk-ant-xxxx and the word task-force-alpha, risk-based-plan, ask-me-anything")
        self.assertEqual(apply(out, self.rules), out)        # the placeholder is not masked again
        self.assertEqual(leaks(out, self.rules), 0)
        self.assertGreater(leaks("Bearer sk-orion-ab12… (masked)", self.rules), 0)   # and an unmasked one is counted as a leak (also for OCR'd frames and images)

    def test_the_key_rule_does_not_assume_the_key_alphabet_or_the_product_word(self):
        for shown in ("sk-orion-ab-c…", "sk-orion-a_b2…", "sk-orion-a…", "sk-orion2-ab12…", "sk-pingone-9z8y…"):
            out = apply(f"Bearer {shown} (masked)", self.rules)
            self.assertRegex(out, r"^Bearer sk-[a-z0-9]+-xxxx… \(masked\)$", shown)
            self.assertEqual(leaks(out, self.rules), 0, shown)
        for masked in ("sk-orion-xxxx…", "sk-orion-xxx…", "sk-orion-xx…"):   # a placeholder OCR read with fewer x's is not a leak
            self.assertEqual(leaks(f"Bearer {masked} (masked)", self.rules), 0, masked)

    def test_the_env_is_read_like_dotenv(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / ".env"; p.write_text(ENV); env = om._env(p)
        self.assertEqual(env["WORKER_A2A_URL"], "https://gw-lb.corp.invalid/worker/a2a")
        self.assertEqual(env["AWS_AGENT_PF_CLIENT_ID"], "demo-client-pass")
        self.assertEqual(env["AWS_AGENT_PF_TOKEN_URL"], "https://someone-pf.corp.invalid/as/token.oauth2")
        self.assertEqual(env["AWS_AGENT_A2A_URL"], "https://gw-node2.corp.invalid/aws-agent-worker")
        self.assertEqual(env["EMPTY_VALUE"], ""); self.assertEqual(env["QUOTED_EMPTY"], "")   # regression: an empty value crashed the reader

    def test_detectors_are_bounded_like_the_masks_so_a_good_take_is_not_blocked(self):
        r = build("WORKER_A2A_URL=https://gw.acme.invalid/a\nAWS_AGENT_PF_CLIENT_ID=aws-agent\n")
        out = apply("client_id aws-agent | path /aws-agent-worker | docs https://myacme.invalid/docs", r)
        self.assertIn("client_id aws-agent-client", out); self.assertIn("/aws-agent-worker", out); self.assertIn("myacme.invalid", out)
        self.assertEqual(leaks(out, r), 0)

    def test_an_object_name_custodian_is_kept_a_person_is_masked(self):
        self.assertIn("aws-agent-caller-identity", apply("aws-agent-caller-identity", build("WORKER_A2A_URL=https://gw.c.invalid/a\nAWS_AGENT_CUSTODIAN=aws-agent-caller-identity\n")))
        self.assertEqual(apply("by first.last%40mail.invalid", build("WORKER_A2A_URL=https://gw.c.invalid/a\nAWS_AGENT_CUSTODIAN=first.last@mail.invalid\n")), "by someone@example.com")

    def test_a_two_part_public_suffix_gives_the_private_domain(self):
        r = build("WORKER_A2A_URL=https://gw.corp.co.uk/a\n", allow=False)
        out = apply("https://gw2.corp.co.uk ops@corp.co.uk and https://bbc.co.uk", r)
        self.assertNotIn("corp.co.uk", out); self.assertIn("https://bbc.co.uk", out)

    def test_a_shared_suffix_is_never_masked_as_a_whole_domain_but_the_exact_host_is_even_when_encoded(self):
        r = build("WORKER_A2A_URL=https://abc123.execute-api.us-east-1.amazonaws.com/a\n", allow=False)
        out = apply("docs https://other.amazonaws.com | resource=https%3A%2F%2Fabc123.execute-api.us-east-1.amazonaws.com%2Fa", r)
        self.assertIn("https://other.amazonaws.com", out); self.assertNotIn("abc123", out); self.assertEqual(leaks(out, r), 0)

    def test_refusals(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertRaises(FileNotFoundError, om.mask_rules, Path(d) / "missing.env")
        self.assertRaises(om.MaskConfigError, build, "MCP_URL=http://127.0.0.1:6883/mcp\n")
        self.assertRaises(om.MaskConfigError, build, "WORKER_A2A_URL=https://gw.corp.invalid/a\nAWS_AGENT_PF_CLIENT_ID=ab\n")
        self.assertRaises(om.MaskConfigError, build, "WORKER_A2A_URL=https://gw.corp.invalid/a\n", False)   # reserved names are skipped outside tests

class PublicImage(unittest.TestCase):
    """A console screenshot on a slide: the page masking cannot change pixels, so only an OCR-clean .redacted copy may be shown."""
    def _assets(self, *names):
        d = tempfile.TemporaryDirectory(); self.addCleanup(d.cleanup)
        for n in names: (Path(d.name) / n).write_bytes(b"x")
        return d.name

    ORIGINAL = "Issuer https://someone-pf.corp.invalid Audience https://gw-lb.corp.invalid/aws-agent-worker"
    CLEAN = "Issuer https://pingfederate.example Audience https://gateway.example/aws-agent-worker client_id=aws-agent-client example-policy"

    def _check(self, redacted, original=ORIGINAL, names=("shot.jpg", "shot.redacted.jpg")):
        ocr = lambda p: redacted if Path(p).name == "shot.redacted.jpg" else original
        return om.public_image("shot.jpg", self._assets(*names), build(ENV), ocr=ocr)

    def _refused(self, redacted, **kw):
        with self.assertRaises(SystemExit) as cm: self._check(redacted, **kw)
        for real in REAL: self.assertNotIn(real, str(cm.exception), real)   # the refusal never repeats a value
        return str(cm.exception)

    def test_the_captured_image_is_never_used_without_a_redacted_copy_or_its_original(self):
        self.assertIn("missing", self._refused(self.CLEAN, names=("shot.jpg",)))
        self.assertIn("missing", self._refused(self.CLEAN, names=("shot.redacted.jpg",)))

    def test_a_redacted_copy_that_still_shows_a_real_value_is_refused(self):
        self._refused("Issuer https://someone-pf.corp.invalid")
        self._refused("Audience https://gw-lb.corp.invalid/aws-agent-worker")
        self._refused("Required Claims client_id=demo-client-pass")
        self._refused("Policies > RichmondRiver-546e6b457145")

    def test_a_value_wrapped_over_two_lines_or_misread_by_ocr_is_still_found(self):
        self._refused("Audience https://gw-lb.corp.\ninvalid/aws-agent-worker")   # the console wraps a long URL
        self._refused("Issuer https://someone-pf.corp,invalid")                 # OCR reads '.' as ','
        self._refused("Policies > richmondriver - 546e6b45714S")               # case, spaces, a letter for a digit

    def test_a_custodian_wrapped_over_two_lines_and_a_console_uuid_are_found(self):
        self._refused("Custodian Owner\nPerson")
        self._refused("Environment 3f2b8c1a-9d4e-4b7a-8c2d-1e5f6a7b8c9d")

    def test_a_real_value_inside_a_placeholder_never_refuses_a_clean_copy(self):
        rules = build(ENV.replace('AWS_AGENT_PF_CLIENT_ID="demo-client-pass"', 'AWS_AGENT_PF_CLIENT_ID="agent-client"'))
        self.assertEqual(om.image_leaks("client_id=aws-agent-client sub aws-agent-client", rules), 0)
        self.assertGreater(om.image_leaks("client_id=agent-client", rules), 0)

    def test_an_original_ocr_cannot_read_cannot_vouch_for_its_copy(self):
        self.assertIn("almost nothing", self._refused(self.CLEAN, original="  | . "))

    def test_ocr_that_cannot_run_refuses_rather_than_passes(self):
        def broken(p): raise FileNotFoundError("tesseract")
        with self.assertRaises(SystemExit):
            om.public_image("shot.jpg", self._assets("shot.jpg", "shot.redacted.jpg"), build(ENV), ocr=broken)

    def test_a_clean_copy_is_what_the_slide_shows(self):
        self.assertEqual(self._check(self.CLEAN), "shot.redacted.jpg")
        self.assertEqual(self._check("Backend https://bedrock-agentcore.us-east-1.amazonaws.com aws-agent-worker 2026-11-21"), "shot.redacted.jpg")

    def test_real_ocr_reads_small_print(self):
        import shutil
        try: from PIL import Image, ImageDraw, ImageFont
        except ImportError: self.skipTest("Pillow not installed")
        if not shutil.which("tesseract"): self.skipTest("tesseract not installed")
        try: big, small = ImageFont.load_default(size=40), ImageFont.load_default(size=14)
        except TypeError: self.skipTest("Pillow too old for a sized default font")
        d = self._assets()
        for name, font in (("shot.jpg", big), ("shot.redacted.jpg", small)):   # the value left in small print, as the review found
            im = Image.new("RGB", (1400, 120), "white"); ImageDraw.Draw(im).text((20, 30), "Issuer https://someone-pf.corp.invalid", fill="black", font=font)
            im.save(Path(d) / name)
        with self.assertRaises(SystemExit): om.public_image("shot.jpg", d, build(ENV))


class TakeClip(unittest.TestCase):
    """The first page of a published video is its title (owner rule 29): the recording is cut to start on the first slide, and to end just after the closing slide."""
    def setUp(self):
        try:
            import take
        except ImportError as e:
            self.skipTest(f"take.py needs {e.name}")
        self.clip = take.clip_window

    def test_it_starts_just_after_the_first_slide_is_drawn_so_no_frame_of_the_page_is_kept(self):
        self.assertEqual(self.clip(5.0, None), {"start": 5.05, "end": None})   # the main segment is not cut short: it ends on the page
        self.assertGreater(self.clip(5.0, None)["start"], 5.0)

    def test_it_ends_just_after_the_closing_slide(self):
        self.assertEqual(self.clip(2.0, 30.0), {"start": 2.05, "end": 30.8})

    def test_a_take_with_no_slide_is_left_whole(self):
        self.assertEqual(self.clip(None, None), {"start": 0.0, "end": None})
        self.assertEqual(self.clip(None, 9.0), {"start": 0.0, "end": None})

    def test_take_py_draws_the_first_slide_before_anything_else_is_cut_and_trims_the_final_encode(self):
        src = (Path(__file__).resolve().parent / "take.py").read_text()
        self.assertIn('clip["first"] = time.monotonic() - clock0', src)
        self.assertIn('if name == "closing": clip["last"]', src)
        self.assertIn('"-ss", str(w["start"])', src)   # the cut is applied to the headless video the release uses


class TakeWiring(unittest.TestCase):
    """take.py checks every slide's image before recording and shows only the checked copy."""
    def setUp(self):
        try:
            import take
        except ImportError as e:
            self.skipTest(f"take.py needs {e.name}")
        self.take = take; self.addCleanup(setattr, take, "PUBLIC_IMAGES", take.PUBLIC_IMAGES)

    def test_opening_closing_and_every_slide_image_is_checked(self):
        seen = []
        orig = om.public_image
        om.public_image = lambda name, assets, rules: seen.append(name) or name.replace(".jpg", ".redacted.jpg")
        self.addCleanup(setattr, om, "public_image", orig)
        out = self.take.public_images([{"image": "open.jpg"}, {"image": "close.jpg"}, None, {"title": "no image"}, {"image": "a.jpg"}], rules={})
        self.assertEqual(seen, ["open.jpg", "close.jpg", "a.jpg"])
        self.assertEqual(out["a.jpg"], "a.redacted.jpg")

    def test_a_masked_take_shows_the_checked_copy_and_never_an_unchecked_image(self):
        captured = []
        orig = self.take._slide_payload
        self.take._slide_payload = lambda cfg, assets: captured.append(cfg["image"])
        self.addCleanup(setattr, self.take, "_slide_payload", orig)
        self.take.PUBLIC_IMAGES = {"a.jpg": "a.redacted.jpg"}
        self.take.slide_payload({"image": "a.jpg"}); self.take.slide_payload({"image": "unchecked.jpg"})
        self.assertEqual(captured, ["a.redacted.jpg", None])

try:
    import playwright.sync_api as pw
    HAVE = True
except ImportError:
    HAVE = False

@unittest.skipUnless(HAVE, "playwright not installed")
class InABrowser(unittest.TestCase):
    def _page(self, rules, url="about:blank"):
        p = pw.sync_playwright().start(); self.addCleanup(p.stop)
        try: b = p.chromium.launch(headless=True)
        except Exception as e: self.skipTest(f"no Chromium ({str(e)[:60]})")
        self.addCleanup(b.close)
        page = b.new_page(); page.add_init_script(om.mask_script(rules)); page.goto(url)
        return page

    def test_the_page_never_shows_a_real_value_even_text_added_or_changed_later(self):
        page = self._page(build(ENV))
        page.evaluate("t => { const pre = document.createElement('pre'); pre.textContent = t; document.body.append(pre); }", PAGE)
        page.evaluate("() => { const t = document.createTextNode('x'); document.body.append(t); t.nodeValue = 'later https://gw-lb.corp.invalid/'; }")
        page.wait_for_timeout(80)
        body = page.inner_text("body")
        for real in REAL: self.assertNotIn(real, body, real)
        self.assertEqual(page.evaluate("() => window.__onscreenMaskLeaks()"), 0)

    def test_a_leak_is_counted_after_it_was_removed_and_across_a_page_load(self):
        import http.server, threading
        srv = http.server.HTTPServer(("127.0.0.1", 0), type("H", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None}))
        threading.Thread(target=srv.serve_forever, daemon=True).start(); self.addCleanup(srv.server_close); self.addCleanup(srv.shutdown)
        url = f"http://127.0.0.1:{srv.server_address[1]}/"
        partial = {"pairs": [], "detect": build(ENV)["detect"]}   # a mask that misses everything: the safety net must still notice
        page = self._page(partial, url)
        page.evaluate("() => { const p = document.createElement('p'); p.textContent = 'https://gw-lb.corp.invalid/'; document.body.append(p); }")
        page.wait_for_timeout(50); page.evaluate("() => document.querySelector('p').remove()")
        page.goto(url)   # a navigation, as the take does
        self.assertGreater(page.evaluate("() => window.__onscreenMaskLeaks()"), 0)

if __name__ == "__main__":
    unittest.main(verbosity=1)
