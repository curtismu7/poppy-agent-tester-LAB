// Page 3: the two credentials the run produced, claim by claim, with the raw JWTs collapsed underneath.
import Json, { POPPY_HOT } from "../Json";
import { latestSession } from "./callRows";

const STANDARDS = [
  { name: "Client ID Metadata Document (CIMD)", text: "The client_id is a URL. The authorization server fetches the agent's metadata and public keys from it, so nothing is registered by hand on the agent's side. This is the core idea. PingOne does not take a metadata document, so there the client_id is a registered application id and the public key is registered on that application instead." },
  { name: "private_key_jwt (RFC 7523)", text: "The agent signs a short assertion with its private key instead of sending a secret. The server checks it against the jwks_uri in client.json (PingFederate) or the key registered on the application (PingOne), at the token endpoint and at the PAR endpoint." },
  { name: "Pushed Authorization Requests (RFC 9126)", text: "The sign-in request goes server to server first; the browser carries only a request_uri. Required by FAPI 2.0 companies. Add DPoP (RFC 9449) and the code is also bound to the agent's key." },
  { name: "Resource indicator (RFC 8707)", text: "The resource parameter names the Company the token is for, so it cannot be replayed at another API. Off by default here because PingFederate refuses a resource it has not registered." },
];

export default function TokenPage({ state }) {
  const token = state?.token;
  const sess = latestSession(state);
  return (
    <section className="rp-page" aria-labelledby="rp-tokens">
      <h2 id="rp-tokens" className="rp-title rp-title--sm">Token &amp; session</h2>
      <p className="muted">The two credentials this run produced, claim by claim. Everything here came off the wire.</p>
      {token?.claims?.sub && (
        <div className="rp-note" data-testid="who-is-this">
          <span className="rp-note__lbl">Who is this?</span>
          <dl className="rp-kv">
            <div><dt>To the authorization server</dt><dd>{token.claims.sub} <span className="muted">(the access token's sub: who signed in)</span></dd></div>
            {sess?.payload?.sub && <div><dt>To this Company's session</dt><dd>{sess.payload.sub} <span className="muted">(the Poppy-Session's sub: a random User ID the agent made up)</span></dd></div>}
          </dl>
          <p>One person, two names. A Company that sees only the Poppy-Session can recognize a returning person but cannot tell who they are. Who they are comes from the signed-in account, through the token (spec 1.0 section 5.1).</p>
        </div>
      )}
      <div className="rp-two">
        <div className="rp-card">
          <h3>Access token</h3>
          <p className="muted">Issued by the authorization server. Says the agent may act for the person on this scope, for a limited time.</p>
          {token ? (
            <>
              <Json value={token.claims} label="Token claims" hot={POPPY_HOT} />
              <details><summary>Raw JWT</summary><Json value={token.access_token} label="Access token" /></details>
            </>
          ) : <p className="muted" data-testid="no-token">No token yet. Sign in on the calls page and the claims appear here.</p>}
        </div>
        <div className="rp-card">
          <h3>Poppy-Session</h3>
          <p className="muted">Signed by the agent for one request. Binds person, agent, method, URL and token. Its sub is a random User ID the agent made up for this Company, not the token's sub. The Company refuses replays and sessions signed for another token.</p>
          {sess?.payload ? (
            <>
              <Json value={sess.payload} label="Poppy-Session claims" hot={POPPY_HOT} />
              <details><summary>Delegation JWT (the poppy_dlg header)</summary><Json value={sess.delegation} label="Delegation" hot={POPPY_HOT} /></details>
              <details><summary>Raw JWT</summary><Json value={sess.raw} label="Poppy-Session" /></details>
            </>
          ) : <p className="muted" data-testid="no-session">No call yet. Call the Company origin on the calls page and the session appears here.</p>}
        </div>
      </div>
      <h3 className="rp-sub">Standards at work in this run</h3>
      <div className="rp-cards rp-cards--4">
        {STANDARDS.map((s) => <div key={s.name} className="rp-card"><h4>{s.name}</h4><p>{s.text}</p></div>)}
      </div>
    </section>
  );
}
