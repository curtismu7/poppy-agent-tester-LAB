// Rule 19: the Mock/Real switch. The server switches at runtime (POST /api/mode); this only asks.
// Real is disabled with the how-to when the server reports realAvailable: false (a hosted build has no
// Company or PingFederate settings, so it fails closed exactly as before).
const REAL_HOW = "Real needs the Company and PingFederate settings (the agent key and the base URL). Give them to the server, then press Real.";
export default function ModeToggle({ info, onChange }) {
  const loading = info === undefined;
  const failed = info === null;
  const source = info?.source;
  const mock = source === "mock";
  const real = source === "real";
  const realAvailable = info?.realAvailable === true;
  return (
    <div className="mode-toggle" role="group" aria-label="Mode" data-testid="mode">
      <button type="button" aria-pressed={mock} disabled={loading || failed || mock} onClick={() => onChange?.("mock")} data-testid="mode-mock">Mock</button>
      <button type="button" aria-pressed={real} disabled={loading || failed || real || !realAvailable} title={!realAvailable ? REAL_HOW : undefined} onClick={() => onChange?.("real")} data-testid="mode-real">Real</button>
      {failed && <span className="mode-toggle__note">Server not answering</span>}
      {loading && <span className="mode-toggle__note">Loading</span>}
    </div>
  );
}
