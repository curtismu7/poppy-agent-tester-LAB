// Deployment configuration. PAT_HOSTED=1 marks the SE build: it explains and replays, and refuses anything that would reach a
// real server. It changes behaviour (live endpoints answer 403) and wording (the banner says HOSTED SIMULATION).
export const hostedFrom = (env = process.env) => env.PAT_HOSTED === '1';
export const baseUrlFrom = (env = process.env) => String(env.PAT_AGENT_BASE_URL || '').replace(/\/+$/, '');
