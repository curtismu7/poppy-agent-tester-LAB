# HITL-style chat + sequence + movie reel (poppy-demo-LAB)

**Status:** draft   **Owner:** Curtis
**Process tier:** 2 (colleagues demo these labs).
**Worktree:** `/Users/cmuir/Development/.wt-poppy-atlas-story` (branch `feat/atlas-h_movie`), based on origin/main 834c004.

## Goal
Bring the HITL-demo presentation style into poppy-demo's Agent chat, so a colleague sees the conversation, the full sequence diagram of every request it caused, and a movie-reel of wire-detail cards — the three surfaces that made the HITL MFA lab and ciba-approval-sequence demos work:

1. **Chat agent** (exists: `AtlasChat` — keep, light touches only).
2. **Sequence diagram** (new): the run's requests as a clickable lifeline sequence — person, agent (this lab), PingFederate, Company API — rendered with the shared `SequenceFlowDiagram` component from ciba-approval-sequence-LAB, driven by the SAME real steps the chat/run produced (`/api/state` steps), not a separate made-up diagram.
3. **Movie reel with details** (new): `DiagramReel` under the sequence — one card per message in walk order, click any card or message for the wire detail (the same raw request/response JSON the Calls page shows), Play/Step/Pause controls.

The diagram tab keeps the existing box-and-arrow `PatternDiagram` (Simulate). The new surface is a second view on the **Agent chat** tab: the chat on the left (unchanged), the live sequence + reel on the right (replacing the flat step list), with the PatternDiagram still available under the Diagram tab.

## Approach
- Vendor from ciba-approval-sequence-LAB into this lab with the family's pin pattern (like run-observability): `SequenceFlowDiagram.jsx/.css`, `DiagramReel.jsx/.css`, `SequenceActorHeader.jsx/.css`, `diagram/UniqueReactFlow.jsx`, `utils/parseSequence.js`, `utils/diagramReel.js`, `utils/specRefs.js`, `hooks/useReelSync.js` — byte-for-byte, one `sequence-diagram.sha256` pin, `scripts/sequence-checkPin.mjs`, a pin test. Never edited here; upstream fixes re-vendor.
- **Live-run sequence text**: build the `sequenceDiagram` DSL string from `/api/state` steps (poppy.json GET, resource GET, PAR, the browser authorize, token, signed call) via a pure `web/src/liveSequence.js` — mirroring how hitl-mfa's `liveFlow.js` maps a run onto its diagram. Rows with no wire yet draw as pending/ghost; an error step draws a dashed refusal arrow with the error text. The registered redirect → the browser → /cb hops collapse into the one "person signs in" lifeline hop (the browser is not a participant).
- The reel's per-message detail comes from the SAME step data (request/response/wire), so nothing is invented; before a step has run, its card shows "not run yet".
- The sequence re-renders as the chat advances (state changes already re-render the step list today); a step the chat just drove is highlighted via the existing `STEP_ARROW`-like mapping (by step kind → sequence row index).

## Acceptance criteria (each a runnable check)
1. Pin test passes: every vendored file byte-matches `sequence-diagram.sha256`; editing a copy fails CI.
2. Chat tab, before any run: the sequence shows the lifelines with the discovery hops as "not run yet" ghosts and the reel says so; no fabricated 200s.
3. After a guided run (Mock `sample.js`? this lab's guided chips run REAL steps — with Real configured the run lands; in Mock the chat is off, so the new view is only meaningful with Real configured OR after a run via the Run it tab): the sequence shows the six real hops in order, each card carries the live request/response, and clicking a message or card opens the detail row with the same JSON as the Calls page.
4. The browser hop (person signs in at PingFederate) renders as one dashed hop person→agent→(lab)→PF labelled "in the browser", never as fabricated PF wires.
5. The stepper: Play/Step/Pause/Stop walk the messages in order; a message click or card click jumps and pauses there (the vendored component's existing behaviour, exercised by a wiring test).
6. Existing tabs unaffected: Diagram tab still renders `PatternDiagram` with Simulate; Run it tab unchanged; chat unchanged on the left. `npm test` all green (server + web + repo checks).
7. Public-safe: only `.example`/`.invalid` and the lab's own documented hosts appear in shipped text; the run-observability, TopMenu, JsonPane, diagram-kit pins untouched.
8. Build green: `npm run build -w web`; Docker build still passes; the image serves the new tab content.

## Unhappy paths (each needs a check)
- A step with `error` and no wire (issuer redirect error, token exchange throw): dashed refusal arrow + reel card carrying the error text; no fabricated request JSON.
- Two runs in one workspace: the sequence shows the LATEST run (same rule the Calls page uses — `latest(steps, kind)`).
- A Real run whose PAR was refused: the PAR hop draws with the refusal status; later hops stay ghosts.
- A workspace where discovery failed outright: the sequence stays in the ghost state with the error on the discovery card.
- Narrow screens (375px): the sequence scrolls sideways (the vendored component's own behaviour); the chat/resizer still work.
- A step kind the mapper does not know (a future server addition): the mapper skips it and the reel numbering stays contiguous; a test fails if the skip is silent for a KNOWN kind.

## Out of scope
- Changing the chat's live/guided behaviour, the tools, or the PF/Company flows.
- A recorded video re-take for the new view (the existing releases stay).
- Story mode wiring for this lab (separate follow-up).
- Any change to the vendored ciba-approval-sequence-LAB files (upstream first, then re-vendor).

## Protected / must not break
- The existing pins: run-observability, JsonPane, diagram-kit, TopMenu, standalone-ui.css.
- The chat's Real-only guard (Mock chat stays off), workspace isolation via `X-Workspace`, netguard's two-typed-hosts rule.
- The Run it tab's call rows and the token page (the reel reads the same state, never a second source of truth).
- Rule 17: the Diagram tab's studio diagram stays loaded by name; no hand-built nodes anywhere.

## Verification plan
- Unit: pin test, `liveSequence.js` mapping tests (happy run, error run, no-run, unknown kind), wiring tests (state → sequence props).
- `npm test` (server + web + repo checks) locally and on the Air.
- Browser (global rule 9): drive the chat through a real guided run against the local PF at 5451, screenshot the sequence + reel at 1920x1080 and 1800x1169, read the screenshots; also check 375px no-overflow.
- `/code-review` on the diff; PR waits for the owner's "merge".
