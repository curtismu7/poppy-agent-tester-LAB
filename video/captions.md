<!--
  Story wording for poppy-demo-LAB. The lab serves this file at GET /api/story (the shared Story parser);
  the live Story reads that. No recorded video exists yet; when one is made it must read this same file.

  Rules for editing safely:
  - The first page has a "## Header" naming what the demo shows (rule 29): keep it on the Opening Slide and on mock_note.
  - Don't rename a "# Opening Slide" / "# Closing Slide" / "# Slide: <key>" / "# Step: <key>" heading, and don't rename
    a "## Header" / "## Title" / "## Text" / "## Lead" / "## Verdict" / "## Column A: ..." / "## Column B: ..." heading.
  - A column heading's label IS shown on the slide; edit it freely, keep "Column A:" / "Column B:" at the line's start.
  - Keep each bullet on its own line starting with "- ".
  - Keep slide text to about 40 words.
  - Say only what the run proved. Mock wording (sample_*) says simulated; it never claims a live result.
  - Public-safe: no internal hostnames, tenant or client ids, keys, customer names. Only .example hosts.
  - "---" on its own line separates sections. Keep those.
-->

# Opening Slide

## Header
Poppy, the personal agent, in conversation

## Title
Ask your agent; watch it introduce itself

## Lead
This lab plays the Personal Agent Protocol as a conversation. You ask your agent a question; it reads the Company's published documents, sends you to the authorization server's own page to sign in, and calls the Company API — every request shown as it happens.

## Column A: What you will see
- The Agent chat: ask, and the agent acts
- The sequence: every request the chat caused
- The movie reel: each message's wire detail

## Column B: What it proves
- Discovery: two public documents, no registration
- Sign-in: CIMD, PAR, PKCE, scoped consent
- The call: a bearer token plus a signed Poppy-Session

## Verdict
Nothing here is invented: every bubble points at a request this run actually made, drawn on the sequence to the right of the chat.

---

# Slide: why_poppy

## Title
Why Poppy exists

## Lead
Today a Company faces two choices for an agent at its door: block it, or let it sign in as the person and do anything they can. Poppy is the middle ground both sides agree on.

## Column A: For the Company
- One published document, any agent
- Which scopes an agent may ask for
- Every visit identified and auditable

## Column B: For the person and the agent
- No password ever handed to the agent
- Consent the person grants and can revoke
- One protocol for every Company

## Verdict
This lab is the agent's side of that agreement: a chat that acts only as its person allows.

---

# Slide: mock_note

## Header
Poppy, the personal agent, in conversation

## Title
Hosted build: a simulated walk-through

## Lead
This hosted build reaches no Company and no authorization server, so it explains the flow and shows an example conversation with invented values, labelled simulated. Run the standalone build to drive the real chat.

## Column A: What is simulated
- The Company documents and the tokens
- The agent's answers and every request
- The sequence and reel show example values

## Column B: What is real
- The protocol's shape, as the spec defines it
- What the person is asked to allow
- Nothing leaves this page

## Verdict
Run the standalone to talk to a Company you name.

---

# Step: chat_intro

## Title
The chat is the agent

## Text
On the left, your agent: you ask in plain words, and it does the protocol for you — no forms, no client registration, no shared secret. On the right, the sequence and the movie reel draw every request the conversation causes, with each message's wire detail one click away.

---

# Step: chat_discover_prompt

## Title
Ask about your order

## Text
The agent knows nothing yet. Press the question below: "Do they have my size in stock?" Before it can answer anything, the agent must read the Company origin's published documents — poppy.json and the protected-resource metadata — from the origin typed above the chat.

---

# Step: chat_discover

## Title
Discovery: two public documents

## Text
The agent read poppy.json — who the Company is, which scopes an agent may ask for, which APIs exist — and the protected-resource metadata, which names the authorization server. The origin must be exactly right: a look-alike path is refused. First message on the sequence, first card on the reel.

---

# Step: chat_signin_prompt

## Title
Now the question that needs you

## Text
Stock lists are public; your orders are not. Press "Where's my order?" — the agent cannot answer that alone. It will send you to the authorization server's own page to sign in: the agent never sees your password.

---

# Step: chat_signin

## Title
You sign in; the agent waits

## Text
The authorization server opens its own page in this browser. The agent is identified by its metadata URL — no client id was ever registered (CIMD) — and the request travelled ahead of the browser (PAR), so nothing can be altered on the way. Sign in there, allow the read, and this page comes back by itself; the story continues when you land.

---

# Step: chat_token

## Title
The code became a token

## Text
Back from the authorization server, the agent exchanged the code — authenticated with its own key (private_key_jwt) — for an access token whose client_id is the agent's URL and whose scope is only what you allowed. The token names the agent, not a machine, and on its own it is not enough to make a call.

---

# Step: chat_call

## Title
The last ask: "So — where is it?"

## Text
Press the question below. The answer needs one more request to the Company's API, and that request carries two proofs: the access token and a Poppy-Session — a short-lived JWT that names this method, this URL, this token — so a stolen token alone is not enough.

---

# Step: chat_done

## Title
The conversation did the protocol

## Text
You asked; the agent discovered, sent you to sign in, exchanged the code, and called — and the sequence beside the chat shows every request it took, each one's wire detail on the reel below. Try the Start flow tab to drive the same steps by hand.

---

# Closing Slide

## Header
Poppy, the personal agent, in conversation

## Title
One protocol, any agent, every visit identified

## Lead
The chat made the whole Personal Agent Protocol happen in conversation: discovery, your sign-in on the authorization server's own page, a token that names the agent, and a signed session on every call — all drawn from the real requests, nothing invented.

## Column A: What you saw
- A question answered by an agent
- Your sign-in, never the agent's
- Every request on the sequence

## Column B: What to try next
- The Start flow tab: the steps by hand
- The reel: every message's wire detail
- The Verify lab: this protocol, checked against the spec

## Verdict
An agent that names itself, asks, and proves itself on every call — that is the agreement Poppy proposes.

---

# Step: sample_chat_discover_prompt

## Title
Ask about your order (simulated)

## Text
This hosted build reaches no Company, so the example conversation runs with simulated values. Press the question below to see the example: in the standalone build, this ask makes the agent read the Company origin's real documents.

---

# Step: sample_chat_discover

## Title
Discovery (simulated example)

## Text
An example of what discovery shows in the standalone build: poppy.json — who the Company is, which scopes an agent may ask for, which APIs exist — and the protected-resource metadata, which names the authorization server. The values here are invented and labelled simulated.

---

# Step: sample_chat_signin

## Title
You sign in; the agent waits (simulated example)

## Text
An example of the sign-in bubble in the standalone build: the authorization server opens its own page, the agent is identified by its metadata URL (CIMD), and the request travelled ahead of the browser (PAR). The values here are invented and labelled simulated.

---

# Step: sample_chat_token

## Title
The code became a token (simulated example)

## Text
An example of the token bubble in the standalone build: the code was exchanged — authenticated with the agent's own key — for an access token whose client_id is the agent's URL and whose scope is only what you allowed. The values here are invented and labelled simulated.

---

# Step: sample_chat_call

## Title
The call (simulated example)

## Text
An example of the call bubble in the standalone build: the agent called the Company's API carrying the access token and a signed Poppy-Session, and the Company verified both. The values here are invented and labelled simulated.
