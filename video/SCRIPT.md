# Script: two A2A demos, one gateway (our two agents, then an agent in AWS)

Written first, before any recording (video standard: every video has a script, built from the specs and docs actually read, not from memory). `captions.md` carries the on-screen wording and must say what this script says. If a source changes, change the script, then the captions, then retake. Revised 2026-11-22 for the two-part cut (the first cut was reviewed 2026-11-21 by an independent reader; its corrections are folded in, and the new reel pop-outs were reviewed the same way on 2026-11-22).

- **Scenario (2026-11-26):** the app's default demo is now an access review at Meridian Air, a fictional airline. The released recording predates this and shows the earlier generic access-review data; the questions in the table below are the airline ones, for the next re-record. Not re-recorded yet. The local SAMPLE-preview fixtures in `video/assets` (untracked) hold the earlier data and must be captured again at that re-record.
- **Format:** silent screen capture with numbered captions and full-screen slides, light theme, about 10 minutes. **No slide is held longer than 10 seconds** (owner, 2026-11-22), so slide text is a skim of at most about 75 words, not a read. Opens and closes with a slide.
- **Part 1, normal A2A (A2A with remote agents tab):** our two agents. The concierge hands a question to the analyst agent over A2A; the analyst reads data over MCP. One question that succeeds (with personal data redacted on the MCP leg) and one that Privilege stops.
- **Part 2, A2A with an agent in AWS (Custodian to AWS agent tab):** the same idea across clouds. Two questions that succeed, then a refusal.
- **Audience:** a colleague who knows what an AI agent is but has not seen A2A or Privilege.
- **One idea:** agent to agent works with a policy point in the middle: the agent proves who it is, the gateway decides, and a bad credential never reaches the other agent.
- **New in this cut:** the API call reel. Every call is a numbered frame; a pop-out shows what was sent, what came back, the decoded token and the specs behind it.

## Sources (read for this script, 2026-11-21 and 2026-11-22)

| Tag | Source | What the script takes from it |
|---|---|---|
| **A2A** | Agent2Agent (A2A) Protocol Specification, release **1.0.0**, <https://a2a-protocol.org/latest/specification/> | §8.1 every A2A server must publish an Agent Card; §8.2 clients find it at `/.well-known/agent-card.json`, in a registry, or by direct configuration; §4.4.1 required card fields, `securitySchemes` optional; §4.5 scheme types; §7.3 the client learns the required auth from the card, gets credentials out of band, and sends them with every request (no MUST/SHOULD in 7.3); §7.4 the server MUST authenticate every incoming request and SHOULD include challenge information in error responses; §5.3 / §9.4.1 sending is `SendMessage` in 1.0.0; §4.1.1 Task, §4.1.7 Artifact; Appendix B A2A and MCP are complementary |
| **AWS-A2A** | Amazon Bedrock AgentCore, "A2A protocol contract", <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a-protocol-contract.html> | JSON-RPC 2.0 over HTTP, POST to `/`; card at `/.well-known/agent-card.json`; AgentCore documents the send method as `message/send` (the 1.0.0 spec calls the operation `SendMessage`); a call without a credential to an OAuth/JWT runtime gets 401 with `WWW-Authenticate` and a `resource_metadata` URL; a SigV4 runtime answers 403 with no challenge; the runtime returns real HTTP statuses with a JSON-RPC error body (authentication failures are plain HTTP errors) |
| **AWS-AUTH** | AgentCore "Authenticate and authorize with Inbound Auth and Outbound Auth" and the inbound JWT authorizer page | Inbound auth is IAM SigV4 (default) or JWT bearer, not both; for a JWT the runtime checks issuer, `client_id`, `aud`, signature and expiry |
| **RFC** | RFC 9110 §15.5.2; RFC 6750 §2.1, §3, §3.1; RFC 9728 §2, §3, §5.1; RFC 7519 §4.1; RFC 7515 §4.1; RFC 9068 §2; RFC 6749 §4.4, §5.1; RFC 8693 §4.1 (fetched from rfc-editor.org and re-checked by an independent reader on 2026-11-22; the wording the pop-outs show is `src/main-agent/reelRefs.ts`) | A 401 MUST carry `WWW-Authenticate` (RFC 9110; RFC 7235 is obsoleted by it); a Bearer token travels in `Authorization` (RFC 6750); `invalid_token` is usually 401; the `resource_metadata` parameter points at the resource's metadata (RFC 9728 §5.1); JWT claims `iss`, `sub`, `aud`, `exp`, `iat`, `jti` (RFC 7519); a JWT access token carries `client_id` (RFC 9068 §2.2); the client-credentials grant (RFC 6749 §4.4); the `act` actor claim (RFC 8693 §4.1) |
| **PRIV** | Ping Identity docs for PingOne Privilege, agent privilege: <https://docs.pingidentity.com/privilege/> | Custodian: the Agent Registry field saying whose identity the agent's actions are attributed to, a User or a Federated Identity (**no glossary sentence from Ping; do not quote one**); key scopes Models (LLM), Tools (MCP), Agents (A2A); API key or workload identity; identity validated on every call; the credential ends at the gateway, which injects what the target needs; Remote Agent auth modes Static Token, User Token, Pass Agent Token, None; policy per app by operation, user or group and time window; AI Guard allows, alerts, sanitizes or blocks on MCP, A2A and LLM traffic; every call auditable in Activity Logs; secrets hubs. **Not documented:** status codes of a denied agent request (the live run supplies them), how a hub secret reaches an agent request |
| **CONSOLE** | The Privilege console, read-only, 2026-11-22 (screens and text read, nothing changed; also the policy `RichmondRiver-546e6b457145` access graph, identity to policy to agent key to app, and the app's Activity Logs) | App `aws-agent-worker`: Remote Agent, backend the AgentCore regional host, Auth Mode **Pass Agent Token**. Agent `aws-agent-caller`: principal `aws-agent-caller-identity` (a federated identity), scope `a2a`, "Policy enforced as: principal identity", authentication by OIDC (issuer, audience = this app's gateway route, subject `*`, JWKS URL, max token lifetime default 3600 s on the gateway), required claims `act.sub` and `client_id`, no API key |
| **LAB** | This repo's README and code | The A2A with remote agents tab: concierge to analyst over A2A (through the gateway in gateway mode), analyst to data over MCP; the AWS tab calls a gateway route and mints a PingFederate client-credentials token for each live call; the reel shows each call with the token decoded (signature never shown) |
| **LIVE** | The prompt tests of 2026-11-21 and the rehearsal before the take | The questions below were run against the live lab twice each; the AWS agent has one tool (`add_numbers`) and does not know where it runs, so no "where do you run" question is used |

**Wire-format note:** AgentCore documents the send method as `message/send`; the 1.0.0 spec calls it `SendMessage`. The video says that once, on the A2A spec slide, and shows the method as it is on the wire.

**Version number:** no A2A protocol version below 1.0.0 is named in the video. The Agent Card panel's `protocolVersion` row is hidden during the recording and the Agent Card frame's pop-out is never opened (AWS's live card carries an older value). The slide says nothing about it.

**Checks before recording (a script is only true if the run is):**

1. Mock/Real switch is on Real and the AWS tab says LIVE route; the take refuses to run otherwise.
2. The A2A with remote agents run goes through the gateway (the page's mode line says so) and the analyst answers.
3. Both AWS answers are correct (987654321 + 123456789 = 1,111,111,110) and the refusal is a 401 at the gateway.
4. The reel shows a decoded token on the live Agent Card, message and token frames (a live token, not the opaque key).
5. The console values on the two configuration slides were read on 2026-11-22; re-read if Privilege changed.

## Scenes

Slides are full screen and unnumbered; caption bubbles are numbered.

| # | On screen | What the viewer reads (gist; exact words in captions.md) | Source |
|---|---|---|---|
| Open | Slide | Two ways to connect agents: each holds the other's credentials, or each presents its own identity to a gateway that checks it first. Two demos: ours to ours, then ours to AWS. | AWS-AUTH; A2A §7.3 |
| **Part 1** | | | |
| 1 | A2A with remote agents tab | Two agents of ours: the concierge you talk to, the analyst that reads data. | LAB |
| 2 | Typing "What can Bob Reyes reach?" | A plain question. The concierge does not hold the data. | LIVE |
| 3 | Who block, A2A arrow | The concierge hands it to the analyst over A2A. The custodian is whose identity this runs as. | PRIV; A2A |
| 4 | Reel frame 1 pop-out | The A2A message, as JSON-RPC; the credential is masked; the specs say what each part is. | A2A §5.3, §9.4.1, §7.3; RFC 6750 §2.1 |
| 5 | Reel MCP frames | The analyst uses MCP to reach the data; A2A is agent to agent, MCP is agent to tools. | A2A Appendix B |
| 6 | MCP result pop-out | The grant is readable; the email came back as `[REDACTED:pii]`. Privilege screened the data in flight. | PRIV (AI Guard); LIVE |
| 7 | Answer | The answer, from the analyst's data. | LIVE |
| 8 | Typing "Review access on passenger-records-db" | Same path, a question whose data the gateway will not pass. | LIVE |
| 9 | Reel with the stopped call | The tool response was blocked by a security policy; no data came back. | PRIV (AI Guard); LIVE |
| **Part 2** | | | |
| Slide | Slide | An agent in AWS (Bedrock AgentCore) reached through the same gateway; our agent holds no AWS credentials. | AWS-AUTH; PRIV |
| 10 | AWS tab, boxes | Custodian, our agent, the gateway checkpoint, the agent in AWS. LIVE route. | LAB; PRIV; CONSOLE |
| Slide x3 | Console screenshots | How Privilege is set up: the app `aws-agent-worker`, the agent `aws-agent-caller` with its federated identity, and the policy that joins them (the policy page's access graph). | CONSOLE; PRIV; RFC 8693 §4.1 |
| Slide | Slide | Five things the A2A specification says, and where each shows up. | A2A |
| Slide | Slide | The RFCs behind what you saw: 6749, 6750, 7519, 9068, 8693, 7515, 9110, 9728, one line each (the same wording as the pop-outs). | RFC |
| 11 | Typing "What tools do you have, and what can you do with them?" | The AWS agent describes its one tool, so the answer can only come from AWS. | LIVE |
| 12 | Reel frame 1: Get a token | Our agent asks PingFederate for a token: the client-credentials grant; the client secret is masked. | RFC 6749 §4.4, §5.1 |
| 13 | Token pop-out | The decoded token: issuer, subject, audience, expiry, client_id, scope, and `act`. Signature never shown. | RFC 7519; RFC 9068 §2.2; RFC 8693 §4.1 |
| 14 | Agent Card frame | The agent card read first, at the well-known path. | A2A §8.1, §8.2 |
| 15 | Message frame pop-out | One JSON-RPC message with the same token on it; the method on the wire. | A2A §5.3, §7.3; AWS-A2A |
| 16 | Answer | The AWS agent's own reply, all four boxes lit. | LIVE |
| 17 | Typing the add_numbers question | A second question that needs the tool; large numbers so the audience can check. | LIVE |
| 18 | Answer | It names the call it made and returns the sum. | LIVE |
| 19 | "Try a refused call" | The same question with a deliberately invalid credential. | LAB |
| 20 | Boxes, then the reel | Refused at the gateway (401); AWS never reached. | LIVE |
| 21 | Refused frame pop-out | A 401 carries a challenge: the parts explained, with the specs. | RFC 9110 §15.5.2; RFC 6750 §3, §3.1; A2A §7.4 |
| 22 | Metadata frame | The challenge points at sign-in metadata; the gateway's own host is the one read. | RFC 9728 §2, §3, §5.1 |
| Slide | Console screenshot | Every call is on record: the app's Activity Logs after the runs (the Agent Card read and the message send as `aws-agent-caller-identity`; the AWS account id is masked in the display before the screenshot). | CONSOLE; PRIV |
| Slide | Slide | What the gateway can protect. | PRIV |
| Close | Slide | What both parts showed, and why it matters. | all |

## What is masked and what is not on screen

- Masked everywhere the lab draws a route or a claim: the AWS account id (`accountId=`, inside an ARN, also URL-encoded). Scan the stills of every take for 12-digit runs before sharing.
- **Not masked, on purpose, internal viewers only:** the gateway host, the PingFederate host and the JWKS URL on the console screenshot and in the decoded token, the PingFederate client id. The screenshots are local-only (`video/assets/` is gitignored; the lab repo is public). Decide before sharing the video outside the company.
- The runtime id is cropped out of the app screenshot.

## Not in this video (on purpose)

- Anything about how a secrets hub supplies an agent credential: Ping's docs do not describe it.
- Which AWS account the runtime is in.
- The raw Agent Card JSON and the card's version field.
