// Shows which mode the server is running and offers the other one. The page cannot switch the server: a hosted build fails closed,
// so Mock and Real are set by how the server was started. The unavailable option is disabled and says how to start it.
const REAL_HOW = "Real needs the server started in live mode: leave MODE unset (or set MODE=live) and give it the Company and PingFederate settings. Restart the server to change modes.";
const MOCK_HOW = "Mock is the hosted simulation. Restart the server with MODE set to anything other than live to switch to it.";

export default function ModeToggle({ hosted }) {
  const loading = hosted === undefined;
  const failed = hosted === null;
  const mock = hosted === true;
  const real = hosted === false;
  return (
    <div className="mode-toggle" role="group" aria-label="Mode" data-testid="mode">
      <button type="button" aria-pressed={mock} disabled={loading || failed || real} title={real ? MOCK_HOW : undefined} data-testid="mode-mock">Mock</button>
      <button type="button" aria-pressed={real} disabled={loading || failed || mock} title={mock ? REAL_HOW : undefined} data-testid="mode-real">Real</button>
      {failed && <span className="mode-toggle__note">Server not answering</span>}
      {loading && <span className="mode-toggle__note">Loading</span>}
    </div>
  );
}
