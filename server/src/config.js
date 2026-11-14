// Deployment configuration (rule 18). One image serves the local standalone and the hosted build.
// The hosted build explains and shows an example run; every endpoint that would reach a real server answers 403. It FAILS CLOSED:
// MODE unset or exactly 'live' is a live local run, and any other MODE value (including an empty one) is the hosted build. PAT_HOSTED set to anything but
// '', '0' or 'false' is the hosted build too. So a typo (MODE=MOCK, MODE=hosted, PAT_HOSTED=true) never starts a live build by accident.
export const modeFrom = (env = process.env) => (env.MODE === undefined || env.MODE === 'live' ? 'live' : 'mock');
export const hostedFrom = (env = process.env) => {
  const p = String(env.PAT_HOSTED ?? '').trim().toLowerCase();
  return (p !== '' && p !== '0' && p !== 'false') || modeFrom(env) === 'mock';
};
export const baseUrlFrom = (env = process.env) => String(env.PAT_AGENT_BASE_URL || '').replace(/\/+$/, '');

// Suggested defaults for the Run it form (owner rule 2026-11-14: a visitor can one-click run it).
// Each deployment names its own Company origin and PingFederate issuer via env; empty by default
// (the placeholders stay .example, per the no-identifiers rule) so nothing ships a real host.
export const demoDefaultsFrom = (env = process.env) => ({
  origin: String(env.PAT_DEMO_COMPANY_ORIGIN || '').trim(),
  issuer: String(env.PAT_DEMO_PF_ISSUER || '').trim(),
  scope: String(env.PAT_DEMO_SCOPE || '').trim(),
});
