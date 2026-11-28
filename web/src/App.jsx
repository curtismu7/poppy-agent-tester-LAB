import { useCallback, useEffect, lazy, Suspense, useState } from "react";
import fs from "node:fs";
import RunPanel from "./components/RunPanel";
import AtlasChat from "./components/AtlasChat";
import DiagramTab from "./components/DiagramTab";
import { getJson, resetWorkspace } from "./api";
import TopMenu, { applyFontSize } from "./top-menu/TopMenu.jsx";
import TalkTrackDialog from "./talk-track/TalkTrackDialog.jsx";
import VerifyMark from "./components/VerifyMark.jsx";
import StoryToggle, { storyKey } from "./story/StoryToggle.jsx";

const StoryRoot = lazy(() => import("./StoryRoot.jsx"));

const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version || null; } catch { return null; } })();

export const STORY_PREFIX = "pat";
export const TABS = [
  { id: "run", label: "Agent" },
  { id: "chat", label: "Details" },
  { id: "diagram", label: "Diagram" },
  { id: "why", label: "Why Poppy" },
  { id: "talk", label: "Talk track" },
];
// Never blank and never claims "not hosted" before it knows: until /api/info answers (or if it fails) it says both.
export const BANNER_UNKNOWN = "LIVE or HOSTED SIMULATION: this page is loading. A local run talks to the Company and PingFederate you name; the hosted build only explains and shows an example.";
export const BANNER_FAILED = "MODE UNKNOWN: the page could not read /api/info from its server, so it cannot say whether this is a live run or a hosted simulation. Every action is off until the server answers.";
const BANNER_LOCAL = "LIVE: this agent talks to the real Company and the real PingFederate you name, and to nothing else. Only the person (a demo user) and the agent are test data.";
const BANNER_HOSTED = "HOSTED SIMULATION: this build explains the flow and shows an example run with invented values. It reaches no Company and no PingFederate. Run the standalone to try it for real.";

const hashTab = () => { const h = window.location.hash.replace("#", ""); return TABS.some((t) => t.id === h) ? h : "run"; };

const THEME_KEY = "poppy.theme";
function initialTheme() {
  try { const t = localStorage.getItem(THEME_KEY); if (t === "light" || t === "dark") return t; } catch { /* storage blocked */ }
  return "auto";
}

export default function App() {
  const [info, setInfo] = useState(undefined); // undefined = loading, null = failed
  const [vertical, setVertical] = useState("banking");
  const [story, setStory] = useState(null);
  const [tab, setTab] = useState(hashTab());
  const [presenter, setPresenter] = useState(false);
  const [storyOn, setStoryOn] = useState(() => { try { return localStorage.getItem(storyKey(STORY_PREFIX)) === "story" || new URLSearchParams(window.location.search).get("story") === "1"; } catch { return false; } });
  const [toggleKey, setToggleKey] = useState(0); // re-mounts the toggle after an in-story Exit so its pressed state follows
  // Exit in the Story bar: back to Demo, remembered, and ?story=1 dropped from the address so a reload stays in Demo.
  const leaveStory = useCallback(() => {
    setStoryOn(false);
    setToggleKey((k) => k + 1);
    try { localStorage.setItem(storyKey(STORY_PREFIX), "demo"); } catch { /* storage blocked: the choice just does not persist */ }
    try { const u = new URL(window.location.href); if (u.searchParams.has("story")) { u.searchParams.delete("story"); window.history.replaceState(null, "", u); } } catch { /* no address to tidy */ }
  }, []);
  const [talkOpen, setTalkOpen] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const [resetMsg, setResetMsg] = useState("");
  const [theme, setTheme] = useState(initialTheme);
  const [fontStep, setFontStep] = useState(() => { try { const f = localStorage.getItem("poppy.font"); return ["S", "M", "L"].includes(f) ? f : "M"; } catch { return "M"; } });
  useEffect(() => { applyFontSize(fontStep); try { localStorage.setItem("poppy.font", fontStep); } catch { /* storage blocked */ } }, [fontStep]);

  useEffect(() => { if (theme === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme; }, [theme]);

  const pickTheme = (next) => {
    try { if (next === "auto") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, next); } catch { /* not remembered */ }
    setTheme(next);
  };

  useEffect(() => { getJson("/api/info").then(setInfo, () => setInfo(null)); }, []);
  useEffect(() => { getJson(`/api/cast?vertical=${encodeURIComponent(vertical)}`).then(setStory, () => setStory(null)); }, [vertical]);
  const TALK = story ? story.talkTrack : [];
  useEffect(() => {
    const on = () => setTab(hashTab());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const select = (id) => { setTab(id); try { window.history.replaceState(null, "", `#${id}`); } catch { /* ignore */ } };

  useEffect(() => {
    const on = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl/Cmd+P is print, not presenter mode
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === "p" || e.key === "P") setPresenter((v) => !v);
      else if (e.key === "Escape") setPresenter(false);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const reset = useCallback(async () => {
    const ok = await resetWorkspace().catch(() => false);
    setResetSignal((n) => n + 1);
    setResetMsg(ok ? "Reset: your sign-in and step log are cleared and the diagram is back in place." : "Reset failed on the server; the view was reset.");
  }, []);

  const onKeyTab = (e, i) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === "Home" ? TABS[0] : e.key === "End" ? TABS[TABS.length - 1] : TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    select(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  const hosted = info ? !!info.hosted : null;
  const banner = info === null ? BANNER_FAILED : hosted === true ? BANNER_HOSTED : hosted === false ? BANNER_LOCAL : BANNER_UNKNOWN;
  return (
    <div className={`app${presenter ? " app--presenter" : ""}`}>
      <header className="shell-bar">
        <span className="shell-brand">
          <span className="shell-logo" aria-hidden="true">PAT</span>
          <h1>Poppy demo</h1>
          {info?.source === "real"
            ? <span className="shell-badge shell-badge--real" data-testid="mode-badge">Real</span>
            : <span className="shell-badge" data-testid="mode-badge">Mock</span>}
        </span>
        <nav className="shell-nav" aria-label="Sections">
          {TABS.map((t, i) => (
            <a key={t.id} id={`tab-${t.id}`} href={`#${t.id}`} aria-current={tab === t.id ? "page" : undefined}
              onClick={(e) => { e.preventDefault(); select(t.id); }} onKeyDown={(e) => onKeyTab(e, i)}>{t.label}</a>
          ))}
        </nav>
        <TopMenu
          mode={{ value: info?.source === "real" ? "real" : "mock", onChange: async (source) => {
            const res = await fetch("/api/mode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source }) }).catch(() => null);
            if (res && res.ok) { const i = await getJson("/api/info").catch(() => null); setInfo(i); getJson(`/api/cast?vertical=${encodeURIComponent(vertical)}`).then(setStory, () => setStory(null)); }
          }, realAvailable: info ? info.realAvailable === true : false, realHint: info?.realReason }}
          vertical={{ value: vertical, onChange: setVertical, options: story ? story.verticals : ["banking"] }}
          theme={{ value: theme, onChange: pickTheme }}
          fontSize={{ value: fontStep, onChange: setFontStep }}
          present={{ active: presenter, onToggle: () => setPresenter((v) => !v), label: "Presenter (P)" }}
          talkTrack={{ active: talkOpen, onToggle: () => setTalkOpen((v) => !v) }}
          shelfUrl="https://local.ping-devops.com:8443/"
          help={{ href: "https://github.com/curtismu7/poppy-demo-LAB#readme" }}
          version={VERSION}
          onReset={reset}
          extra={<StoryToggle key={toggleKey} prefix={STORY_PREFIX} onChange={setStoryOn} />}
        >
          <VerifyMark id="poppy-demo" />
        </TopMenu>
      </header>
      <main className="page">
        <p className="banner" role="status" data-testid="banner">{banner}</p>
        <p className="sr-only" role="status" aria-live="polite">{resetMsg}</p>
        {!presenter && <p className="intro">Play the personal agent from the Personal Agent Protocol: discover a Company, sign in with a URL as your client id, and call its API with a signed Poppy-Session.</p>}
        <div id={`panel-${tab}`}>
          {presenter && tab !== "talk" && (
            <aside className="presenter-say" data-testid="presenter-say" aria-label="Talk track">
              {TALK.filter((t) => (tab === "run" ? ["say-first", "discover", "signin", "call"] : tab === "chat" ? ["say-first", "why-poppy"] : tab === "why" ? ["why-poppy", "value-company", "value-developer", "value-person", "value-ping"] : ["say-first", "why"]).includes(t.id)).map((t) => <p key={t.id}><strong>{t.title}.</strong> {t.say}</p>)}
            </aside>
          )}
          {storyOn && (
            <Suspense fallback={null}>
              <StoryRoot mode={info?.source === "real" ? "real" : "mock"} ready={info !== undefined} onExit={leaveStory} prefix={STORY_PREFIX} />
            </Suspense>
          )}
          {tab === "run" && <RunPanel info={info} resetSignal={resetSignal} />}
          {tab === "chat" && <AtlasChat info={info} resetSignal={resetSignal} />}
          {tab === "diagram" && <DiagramTab resetSignal={resetSignal} />}
          {tab === "why" && (
            <div className="talk" data-testid="why-poppy">
              {TALK.filter((t) => ["why-poppy", "value-company", "value-developer", "value-person", "value-ping"].includes(t.id)).map((t) => <section key={t.id}><h2>{t.title}</h2><p>{t.say}</p></section>)}
            </div>
          )}
          {tab === "talk" && (
            <div className="talk">{TALK.map((t) => <section key={t.id}><h2>{t.title}</h2><p>{t.say}</p></section>)}</div>
          )}
        </div>
      </main>

      <TalkTrackDialog isOpen={talkOpen} onClose={() => setTalkOpen(false)} talk={story?.talkTrack ?? []} />
    </div>
  );
}
