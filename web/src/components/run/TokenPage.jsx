// Page 3: the two credentials the run produced, claim by claim, with the raw JWTs collapsed underneath.
import Json, { POPPY_HOT } from "../Json";
import { latestSession } from "./callRows";

const STANDARDS = [
  { name: "Client ID Metadata Document (CIMD)", text: "The client_id is a URL. The authorization server fetches the agent's metadata and public keys from it, so nothing is registered by hand on the agent's side. This is the core idea." },
  { name: "private_key_jwt (RFC 7523)", text: "The agent signs a short assertion with its private key instead of sending a secret. The server checks it against the jwks_uri in client.json, at the token endpoint and at the PAR endpoint." },
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
          ) : <p className="muted" data-testid="no-session">No call yet. Call the Company on the calls page and the session appears here.</p>}
        </div>
      </div>
      <h3 className="rp-sub">Standards at work in this run</h3>
      <div className="rp-cards rp-cards--4">
        {STANDARDS.map((s) => <div key={s.name} className="rp-card"><h4>{s.name}</h4><p>{s.text}</p></div>)}
      </div>
    </section>
  );
}
