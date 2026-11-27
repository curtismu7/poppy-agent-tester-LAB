# Story mode (poppy-demo-LAB)

**Status:** draft   **Owner:** Curtis
**Process tier:** 2 (colleagues demo these labs).
**Worktree:** `/Users/cmuir/Development/.wt-poppy-atlas-story2` (branch `feat/story-mode`), based on origin/main 9f178f6.

## Goal
Give this lab the family's Story mode — the guided walk-through with numbered pop-up bubbles and slides, the **Demo | Story** toggle in the TopMenu extra slot, Next/Back, and Play for me — following `shared/story/ADDING-TO-A-LAB.md`, with `poppy-verification-LAB` (main, merged lab #21) as the closest sibling reference: same Poppy flow, same person-sign-in pause/resume problem, same tab shell.

The story walks what this lab is FOR: the **Agent chat** — a person asks their agent a question, the agent discovers the Company, sends the person to the authorization server's own page to sign in, exchanges the code, and calls the Company API — with the run's steps always visible as the live sequence + movie reel (added in lab PR #51).

## What the walk-through does (one pass)
1. Opening slide (names the demo, rule 29) → why-Poppy slide on the Why tab.
2. Agent chat tab: bubble on the chat, prompt step pressing the discover chip ("Do they have my size in stock?").
3. Bubbles on the run's results: discovery answer → the sign-in prompt chip (prompt step: "Where's my order?") → **the browser leaves for PingFederate's own page** (the pause/resume mechanic below) → after the redirect back, the token exchange and the call bubbles land on the sequence/reel cards the run produced → closing slide.
4. Mock/hosted note first when the lab is hosted (`sample_*` wording says simulated; hosted builds reach no Company).

## The sign-in pause/resume (the one hard part)
Pressing the sign-in chip redirects the browser away and back (`?signin=ok#chat`); the page reloads and Story restarts. This is exactly poppy-verification's consent redirect (lab #21/#22):
- The chat's run events come as `pat:run-start` / `pat:run-end` window events (new, added beside the existing chat actions — the same contract as `pv:run-*`).
- `sessionStorage['pat.story.playing']` carries Play across the reload; `StoryRoot` resumes it after the wordings load (poppy-verification's proven pattern).
- `?story=1` survives the redirect (the chat's authorize URL keeps the query on the return URL — same fix as lab #22's `storyReturn`).
- Steps whose bubble claims a result (token, call) only show when the page's own state shows it (`/api/state` kinds), so a walk interrupted at the sign-in never lies.

## Acceptance criteria
1. Pin ok (`scripts/story-checkPin.mjs`), parity ok both ways, wording public-safe, first slide in each mode has a `## Header`.
2. `GET /api/story` serves `video/captions.md` (200; broken file → 500 without a server path; edit shows without restart); the Docker image contains the file.
3. Demo mode byte-identical behaviour with Story off (toggle off = no story code loaded; lazy chunk).
4. `walk.py` exit 0 at 1920×1080 and 1800×1169, screenshots read; `play.py` exit 0 with the unattended run crossing the sign-in redirect and reaching done.
5. Lab tests green (web vitest, server jest-equivalent, repo checks) and web build green.
6. Real walked (this Mac has the local PingFederate + shims); Mock walked (hosted mode) — both, or the PR says which was not.

## Unhappy paths
- **Viewer presses Send early / reloads mid-story:** the host's `runInFlight`/`onRun` hooks handle it (runbook §5, mistake 18); a result already on the page is shown at once.
- **Sign-in refused / consent denied:** the bubble on the call step is gated on the step's presence; the story continues with a "carry on" reason, never claims success.
- **Hosted build (no live config):** `sample_*` wording only, labelled simulated; the discover prompt is skipped when the chips are disabled (`when` conditions read `/api/info.hosted`).
- **Esc:** the StoryBar exits on Esc unless a modal (reel detail, talk-track dialog) stops propagation — tested from the chat's input field.
- **A step's target missing** (no PAR in this run, no sequence card): skips silently (mistake 2).

## Out of scope
- No video recording (this lab has none); `captions.md` is Story-only for now.
- No change to the chat's behaviour, the sequence/reel (PR #51 code), or the Run it tab.
- No cluster/hosted deployment work beyond the Dockerfile copying `video/captions.md`.
