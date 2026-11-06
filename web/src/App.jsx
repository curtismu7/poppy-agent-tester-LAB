import { useCallback, useEffect, useRef, useState } from "react";
import RunPanel from "./components/RunPanel";
import DiagramTab from "./components/DiagramTab";
import { getJson, resetWorkspace } from "./api";
import ModeToggle from "./components/ModeToggle.jsx";
import ShelfLink from "./components/ShelfLink.jsx";

export const TABS = [
  { id: "run", label: "Run it" },
  { id: "diagram", label: "Diagram" },
  { id: "talk", label: "Talk track" },
];
// Never blank and never claims "not hosted" before it knows: until /api/info answers (or if it fails) it says both.
export const BANNER_UNKNOWN = "LIVE or HOSTED SIMULATION: this page is loading. A local run talks to the Company and PingFederate you name; the hosted build only explains and shows an example.";
export const BANNER_FAILED = "MODE UNKNOWN: the page could not read /api/info from its server, so it cannot say whether this is a live run or a hosted simulation. Every action is off until the server answers.";
const BANNER_LOCAL = "LIVE: this agent talks to the real Company and the real PingFederate you name, and to nothing else. Only the person (a demo user) and the agent are test data.";
const BANNER_HOSTED = "HOSTED SIMULATION: this build explains the flow and shows an example run with invented values. It reaches no Company and no PingFederate. Run the standalone to try it for real.";

const hashTab = () => { const h = window.location.hash.replace("#", ""); return TABS.some((t) => t.id === h) ? h : "run"; };

const THEME_KEY = "poppy.theme";
const THEMES = [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]];
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
  const [resetSignal, setResetSignal] = useState(0);
  const [resetMsg, setResetMsg] = useState("");
  const [theme, setTheme] = useState(initialTheme);
  const tabsRef = useRef(null);

  useEffect(() => { if (theme === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme; }, [theme]);

  const pickTheme = (next) => {
    try { if (next === "auto") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, next); } catch { /* not remembered */ }
    setTheme(next);
  };

  useEffect(() => { getJson("/api/info").then(setInfo, () => setInfo(null)); }, []);
  useEffect(() => { getJson(`/api/story?vertical=${encodeURIComponent(vertical)}`).then(setStory, () => setStory(null)); }, [vertical]);
  const TALK = story ? story.talkTrack : [];
  useEffect(() => {
    const on = () => setTab(hashTab());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const select = (id) => { setTab(id); try { window.history.replaceState(null, "", `#${id}`); } catch { /* ignore */ } };

  useEffect(() => {
    const strip = tabsRef.current; const el = document.getElementById(`tab-${tab}`);
    if (!strip || !el) return;
    const left = el.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft || left + el.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = Math.max(0, left - 8);
  }, [tab]);

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
      <header>
        <p className="banner" role="status" data-testid="banner">{banner}</p>
        <div className="head">
          <div>
            <h1>Poppy Agent Tester</h1>
            {!presenter && <p className="intro">Play the personal agent from the Personal Agent Protocol: discover a Company, sign in with a URL as your client id, and call its API with a signed Poppy-Session.</p>}
          </div>
          <div className="head__tools">
            <ShelfLink />
            <ModeToggle info={info} onChange={async (source) => {
        const res = await fetch("/api/mode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source }) }).catch(() => null);
        if (res && res.ok) { const i = await getJson("/api/info").catch(() => null); setInfo(i); getJson(`/api/story?vertical=${encodeURIComponent(vertical)}`).then(setStory, () => setStory(null)); }
      }} />
            {!presenter && (
              <label className="inline">Vertical{" "}
                <select value={vertical} onChange={(e) => setVertical(e.target.value)} data-testid="vertical">
                  {(story ? story.verticals : ["banking"]).map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
            )}
            <label className="shell-theme">Theme
              <select value={theme} onChange={(e) => pickTheme(e.target.value)}>
                {THEMES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </label>
            <button type="button" onClick={reset} data-testid="reset">Reset</button>
            <button type="button" aria-pressed={presenter} onClick={() => setPresenter((v) => !v)} data-testid="presenter">{presenter ? "Exit presenter (Esc)" : "Presenter (P)"}</button>
          </div>
        </div>
      </header>
      <main>
        <p className="sr-only" role="status" aria-live="polite">{resetMsg}</p>
        <div role="tablist" aria-label="Sections" className="tabs" ref={tabsRef}>
          {TABS.map((t, i) => (
            <button key={t.id} id={`tab-${t.id}`} role="tab" type="button" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1}
              onClick={() => select(t.id)} onKeyDown={(e) => onKeyTab(e, i)}>{t.label}</button>
          ))}
        </div>
        <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {presenter && tab !== "talk" && (
            <aside className="presenter-say" data-testid="presenter-say" aria-label="Talk track">
              {TALK.filter((t) => (tab === "run" ? ["say-first", "discover", "signin", "call"] : ["say-first", "why"]).includes(t.id)).map((t) => <p key={t.id}><strong>{t.title}.</strong> {t.say}</p>)}
            </aside>
          )}
          {tab === "run" && <RunPanel info={info} resetSignal={resetSignal} />}
          {tab === "diagram" && <DiagramTab resetSignal={resetSignal} />}
          {tab === "talk" && (
            <div className="talk">{TALK.map((t) => <section key={t.id}><h2>{t.title}</h2><p>{t.say}</p></section>)}</div>
          )}
        </div>
      </main>
    </div>
  );
}
