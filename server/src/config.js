// Deployment configuration (rule 18). One image serves the local standalone and the hosted SE build.
// MODE=mock (or PAT_HOSTED=1) is the hosted build: it explains and replays an example run, and every endpoint that would reach a real
// server answers 403. The default is a live local run. It changes behaviour (live endpoints) and wording (the banner).
export const modeFrom = (env = process.env) => (env.MODE === 'mock' ? 'mock' : 'live');
export const hostedFrom = (env = process.env) => env.PAT_HOSTED === '1' || modeFrom(env) === 'mock';
export const baseUrlFrom = (env = process.env) => String(env.PAT_AGENT_BASE_URL || '').replace(/\/+$/, '');
