// Page 1: what the Personal Agent Protocol is and why a Company or an agent developer would care. No data, just the pitch.
const CARDS = [
  { title: "No key handouts", text: "The agent is its own client. The authorization server reads the agent's client.json and issues a token that names it. Nothing to copy, nothing to leak." },
  { title: "The person stays in charge", text: "Consent is one screen. The Company sees exactly which agent acted for which person, and the person can revoke the agent like any other app." },
  { title: "Every hop speaks for itself", text: "The token, the session signature and the delegation JWT are all inspectable on the next pages: the whole trust chain in the open." },
];

export default function IntroPage() {
  return (
    <section className="rp-page" aria-labelledby="rp-intro">
      <p className="rp-eyebrow">Personal Agent Protocol &middot; spec 1.0</p>
      <h2 id="rp-intro" className="rp-title">Your agent. Your login. The Company's API.</h2>
      <p className="rp-lede">
        The Personal Agent Protocol is how a person's AI agent starts from a Company origin it has never seen and gets real work done without anyone pasting API keys.
        The agent <b>names itself with a URL</b>, the person <b>signs in once</b> at the Company's authorization server, and every request after that is <b>signed, scoped and auditable</b>.
      </p>
      <div className="rp-cards">
        {CARDS.map((c) => <div key={c.title} className="rp-card"><h3>{c.title}</h3><p>{c.text}</p></div>)}
      </div>
      <p className="rp-strip"><b>What you'll see:</b> three moves &mdash; <b>read the Company</b>, <b>sign in as the agent</b>, <b>call the API</b>. The next page lists every request in order; the last page shows the token and the session it produced. Every request and response is real.</p>
      <p className="muted" data-testid="intro-clients"><b>Who is the client?</b> With PingFederate the agent is its own client: the client_id is the URL of its client.json (CIMD). PingOne has no CIMD, so there the agent signs in with a registered client_id, set with PAT_P1_CLIENT_ID and PAT_DEMO_P1_ISSUER. Everything else is the same: PKCE, a signed assertion instead of a secret, and the Poppy-Session.</p>
    </section>
  );
}
