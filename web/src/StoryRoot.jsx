import { useEffect, useRef, useState } from "react";
import { createOverlay } from "./story/overlay.js";
import { createStory } from "./story/engine.js";
import StoryBar from "./story/StoryBar.jsx";
import { createHost, buildSteps } from "./storyWiring.js";

// Story mode, loaded only when the viewer turns Story on (App lazy-loads this file, so Demo mode never pays for it). It fetches the wording, builds the
// engine from the script and the page host, starts the walk-through, and tears everything down when it is switched off. A Mock/Real switch restarts the
// walk-through (the steps and the wording differ between the two).

const storage = () => { try { return window.localStorage; } catch { return null; } };

export default function StoryRoot({ mode, ready = true, onExit, prefix = "pvl" }) {
  const [story, setStory] = useState(null);
  const [error, setError] = useState("");
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    let live = true;
    let parts = null;
    window.__storyOn = true;
    document.documentElement.classList.add("story-on");
    fetch("/api/story", { headers: { Accept: "application/json" } })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
        return body;
      })
      .then((captions) => {
        if (!live) return;
        const host = createHost({ mode: () => modeRef.current });
        const overlay = createOverlay();
        const s = createStory({ steps: buildSteps({ captions, host }), captions, overlay, host, store: storage(), prefix });
        let wasActive = false;
        s.subscribe((st) => {
          // The sign-in redirect reloads the page mid-walk; if Play for me was running, resume it so an unattended run crosses the consent screen.
          try { if (st.playing) sessionStorage.setItem("pat.story.playing", "1"); else sessionStorage.removeItem("pat.story.playing"); } catch { /* storage blocked */ }
          if (wasActive && !st.active && live) onExit();
          wasActive = st.active;
        });
        // Resume Play after the consent redirect (the engine restarted; the walk continues unattended as before the reload).
        let resumePlay = false;
        try { resumePlay = sessionStorage.getItem("pat.story.playing") === "1"; sessionStorage.removeItem("pat.story.playing"); } catch { /* storage blocked */ }
        if (resumePlay) { let resumed = false; const once = (st) => { if (!resumed && st.status === "showing") { resumed = true; s.play(); } };
          const offOnce = s.subscribe(once); setTimeout(() => { if (!resumed) { resumed = true; s.play(); } offOnce(); }, 10000); }
        parts = { host, overlay, s };
        setStory(s);
      })
      .catch((e) => { if (live) setError(e.message || "The Story wording could not be loaded."); });
    return () => {
      live = false;
      delete window.__storyOn;
      document.documentElement.classList.remove("story-on");
      if (parts) {
        const { s, host, overlay } = parts;
        s.exit().finally(() => { s.destroy(); host.dispose(); overlay.destroy(); });
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- one story per time Story is switched on

  // Start once the wording is loaded AND the server's mode is known (a Real lab must not flash the Mock walk-through). A mode switch restarts the walk.
  const started = useRef(false);
  useEffect(() => {
    if (!story || !ready) return;
    if (!started.current) { started.current = true; story.start(); return; }
    window.dispatchEvent(new CustomEvent("pat:reset"));
    story.restart();
  }, [story, ready, mode]);

  if (error) {
    return (
      <div className="story-bar" role="alert" data-testid="story-error">
        <span className="story-msg">Story could not start: {error}</span>
        <button type="button" onClick={onExit}>Exit</button>
      </div>
    );
  }
  return story ? <StoryBar story={story} mock={mode === "mock"} /> : null;
}
