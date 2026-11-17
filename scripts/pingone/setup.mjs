#!/usr/bin/env node
// Creates the PingOne objects the Poppy Agent Tester needs for a registered client: a custom resource with one scope,
// an OIDC web app (private_key_jwt, PAR, PKCE) that holds the agent's public key inline, and the grant between them.
// Optional: one demo user with a generated password (--demo-user).
//   node scripts/pingone/setup.mjs [--region com] [--base-url http://127.0.0.1:5450] [--name ...] [--audience ...]
//                                  [--env-file .env] [--state-file .data/pingone-state.json] [--worker-env-id <uuid>] [--demo-user]
// It asks for the environment id, the worker client id and the worker client secret (read without echo). The secret is
// never an argument, never read from the environment, never stored.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  REPO_ROOT, STATE_SCHEMA, UUID_RE, REGIONS, DEFAULT_NAME, DEFAULT_AUDIENCE, DEFAULT_BASE_URL, COMPANY_ORIGIN_DEFAULT, SCOPE_NAME, DEMO_USERNAME,
  SafeError, createApi, basesFor, issuerFor, checkName, checkAudience, checkUuid, normalizeBaseUrl, resolvePaths, resourceNameFor,
  findResource, createResource, findScope, createScope, findApplication, getApplication, createApplication, applicationDiffs, jwksString,
  findGrant, createGrant, findDefaultPopulation, findUser, createUser, setUserPassword, generatePassword,
  readEnvValue, readEnvLine, updateEnvFile, readState, writeState, loadAgent, parseSetupArgs, createTerminalPrompt, terminalOrThrow, printError,
} from './lib.mjs';

const USAGE = `usage: node scripts/pingone/setup.mjs [--region com|ca|eu|com.au|sg|asia] [--base-url <origin>] [--name <app name>]
       [--audience <resource audience>] [--env-file <path>] [--state-file <path>] [--worker-env-id <uuid>] [--demo-user]
Prompts for the environment id, worker client id and worker client secret (no echo). Needs a terminal.
--worker-env-id: the environment the worker application lives in, when it is not the environment being set up (often the administrator environment).
`;

const DIFFERS = 'application exists but differs; run teardown then setup';

export async function runSetup(opts = {}, deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const out = (line = '') => stdout.write(`${line}\n`);
  try {
    return await setup(opts, { ...deps, stdout, stderr }, out);
  } catch (e) {
    printError(stderr, e);
    return { exitCode: 1 };
  }
}

async function setup(opts, deps, out) {
  const cwd = deps.cwd ?? REPO_ROOT;
  const prompt = deps.prompt;
  if (!prompt) throw new SafeError('no prompt available');
  const region = opts.region ?? 'com';
  if (!REGIONS.includes(region)) throw new SafeError(`--region must be one of ${REGIONS.join(', ')}`);
  const name = checkName(opts.name ?? DEFAULT_NAME);
  const audience = checkAudience(opts.audience ?? DEFAULT_AUDIENCE);
  const paths = resolvePaths({ cwd, env: deps.env ?? process.env, envFile: opts.envFile, stateFile: opts.stateFile });
  const flagWorkerEnv = opts.workerEnvId === undefined ? null : checkUuid(opts.workerEnvId, '--worker-env-id');

  // base url: explicit flag, else the existing .env value, else the default. A flag that disagrees with .env is an error.
  const existingBase = readEnvValue(paths.envFile, 'PAT_AGENT_BASE_URL');
  const explicit = opts.baseUrl === undefined ? null : normalizeBaseUrl(opts.baseUrl);
  const existing = existingBase === null ? null : normalizeBaseUrl(existingBase, 'PAT_AGENT_BASE_URL in the env file');
  if (explicit && existing && explicit !== existing) {
    throw new SafeError(`--base-url ${explicit} differs from PAT_AGENT_BASE_URL=${existing} in ${paths.envFile}; this script does not edit that line (change one of them)`);
  }
  const baseUrl = explicit ?? existing ?? normalizeBaseUrl(DEFAULT_BASE_URL);

  // inputs
  const envId = checkUuid(await prompt.ask('PingOne environment ID: '), 'environment ID');
  const workerId = checkUuid(await prompt.ask('Worker client ID: '), 'worker client ID');
  const wantUser = opts.demoUser === true ? true : opts.demoUser === false ? false
    : /^y(es)?$/i.test(String(await prompt.ask(`Create one demo user (${DEMO_USERNAME}) with a generated password? [y/N]: `, { default: 'n' })).trim());
  const secret = await prompt.secret('Worker client secret (hidden): ');
  if (!secret) throw new SafeError('the worker client secret is empty');

  const workerEnvId = flagWorkerEnv ?? envId; // the token is minted where the worker lives; every management call goes to envId
  const bases = deps.bases ?? basesFor(region);
  const api = createApi({ authBase: bases.auth, apiBase: bases.api, fetchImpl: deps.fetch ?? fetch });
  const issuer = issuerFor(region, envId);

  // state: continue an earlier run, or start one
  let state = readState(paths.stateFile);
  if (state && (state.environmentId !== envId || state.region !== region)) {
    throw new SafeError(`${paths.stateFile} belongs to environment ${state.environmentId} (${state.region}); run teardown first`);
  }
  state ??= { schema: STATE_SCHEMA, createdAt: new Date().toISOString(), region, environmentId: envId, baseUrl, objects: {}, env: {} };
  if (workerEnvId !== envId) state.workerEnvironmentId = workerEnvId; else delete state.workerEnvironmentId;
  const persist = () => writeState(paths.stateFile, state);
  const record = (kind, fields, created) => {
    const prev = state.objects[kind];
    state.objects[kind] = { ...fields, created: (prev?.id === fields.id && prev.created === true) || created };
    if (state.intents) { delete state.intents[kind]; if (!Object.keys(state.intents).length) delete state.intents; }
    persist();
  };
  // An object this tool created earlier must be the one this run resolves to. Otherwise a second run (another --name or --audience, a renamed
  // app) would create a second object and forget the first. Checked before anything is created.
  const refuseIfOwned = (kind, foundId) => {
    const prev = state.objects[kind];
    if (prev?.created === true && prev.id !== foundId) throw new SafeError(`this tool already created the ${kind} ${prev.id}, and this run does not resolve to it; run teardown first`);
  };
  // Before each POST the intent (what is about to be created) goes into the state file. If the response is lost the object may exist, so the
  // rerun that finds it by that identity treats it as created by this tool. A definite HTTP error means nothing was created: the intent is dropped.
  const attempt = async (kind, intent, create) => {
    state.intents = { ...state.intents, [kind]: intent };
    persist();
    try { return await create(); } catch (e) {
      if (typeof e?.status === 'number') { delete state.intents[kind]; if (!Object.keys(state.intents).length) delete state.intents; persist(); }
      throw e;
    }
  };
  const claimed = (kind, identity) => Boolean(state.intents?.[kind]) && Object.entries(identity).every(([k, v]) => state.intents[kind][k] === v);

  const agent = loadAgent(paths.dataDir);
  const jwks = jwksString(agent);

  // step 0: where does this environment's AS say it is (never fails the run)
  const meta = await api.discover(envId);
  if (!meta) out('note: could not read the environment metadata (step skipped)');
  else {
    if (meta.issuer !== issuer) out(`warning: the metadata issuer is ${meta.issuer}, setup will write ${issuer}`);
    out(`metadata: PAR endpoint ${meta.pushed_authorization_request_endpoint ? 'listed' : 'NOT listed'}, private_key_jwt ${meta.token_endpoint_auth_methods_supported?.includes('private_key_jwt') ? 'listed' : 'NOT listed'}`);
  }

  // step 1: worker token
  const token = await api.mintToken(workerEnvId, workerId, secret);
  const s = api.session(envId, token);
  out('worker token minted');

  // step 2: resource
  let resource = await findResource(s, audience);
  refuseIfOwned('resource', resource?.id);
  let created = false;
  if (!resource) {
    try {
      resource = await attempt('resource', { audience }, () => createResource(s, { audience, name: resourceNameFor(name) }));
    } catch (e) {
      if (e?.status === 400 && /UNIQUENESS/i.test(e.message) && !e.hint) e.hint = 'a resource with this name or audience already exists in the environment: pick another --name (it also names the resource), or run teardown if an earlier setup made it';
      throw e;
    }
    created = true;
  } else created = claimed('resource', { audience });
  record('resource', { id: resource.id, audience }, created);
  out(`resource ${created ? 'created' : 'found'}: ${resource.id}`);

  // step 3: scope
  let scope = await findScope(s, resource.id, SCOPE_NAME);
  refuseIfOwned('scope', scope?.id);
  created = false;
  if (!scope) { scope = await attempt('scope', { resourceId: resource.id, name: SCOPE_NAME }, () => createScope(s, resource.id)); created = true; }
  else created = claimed('scope', { resourceId: resource.id, name: SCOPE_NAME });
  record('scope', { id: scope.id, name: SCOPE_NAME }, created);
  out(`scope ${created ? 'created' : 'found'}: ${SCOPE_NAME}`);

  // step 4: application
  let app = await findApplication(s, name);
  refuseIfOwned('application', app?.id);
  created = false;
  if (app) {
    created = claimed('application', { name });
    const diffs = applicationDiffs(await getApplication(s, app.id), { baseUrl, kid: agent.kid });
    if (diffs.length) throw new SafeError(`${DIFFERS} (${diffs.join(', ')} not as expected)`);
  } else {
    try {
      app = await attempt('application', { name }, () => createApplication(s, { name, baseUrl, jwks }));
    } catch (e) {
      if (e?.status === 400 && /redirectUri/i.test(e.message) && !e.hint) e.hint = `rerun with --base-url https://<host>:<port> (PingOne may refuse ${baseUrl}/cb)`;
      throw e;
    }
    created = true;
  }
  record('application', { id: app.id, name }, created);
  out(`application ${created ? 'created' : 'found'}: ${app.id}`);

  // step 5: grant
  let grant = await findGrant(s, app.id, resource.id);
  refuseIfOwned('grant', grant?.id);
  created = false;
  if (grant) {
    if (!grant.scopes?.some((x) => x.id === scope.id)) throw new SafeError(`${DIFFERS} (the grant lacks ${SCOPE_NAME})`);
    created = claimed('grant', { appId: app.id, resourceId: resource.id });
  } else {
    grant = await attempt('grant', { appId: app.id, resourceId: resource.id }, () => createGrant(s, app.id, resource.id, scope.id));
    created = true;
  }
  record('grant', { id: grant.id }, created);
  out(`grant ${created ? 'created' : 'found'}: ${grant.id}`);

  // optional: demo user (section 10 of the contract)
  if (wantUser) await demoUser({ s, api, state, record, attempt, claimed, out });

  // step 6: outputs. The state file first (with the values about to be written), then .env, then the summary.
  const owned = {
    PAT_P1_CLIENT_ID: app.id,
    PAT_DEMO_P1_ISSUER: issuer,
    COMPANY_ISSUER: issuer,
    COMPANY_AUDIENCE: audience,
    COMPANY_AGENT_CLIENT_ID: app.id,
    COMPANY_AGENT_JWKS_URI: `${baseUrl}/jwks.json`,
  };
  const addOnly = { PAT_AGENT_BASE_URL: baseUrl, PAT_DEMO_COMPANY_ORIGIN: COMPANY_ORIGIN_DEFAULT };
  // An owned key the user already had with another value: remember its raw line so teardown can put it back.
  const previous = {};
  for (const k of Object.keys(owned)) {
    const current = readEnvValue(paths.envFile, k);
    if (current !== null && current !== owned[k] && current !== state.env[k]) previous[k] = readEnvLine(paths.envFile, k);
  }
  if (Object.keys(previous).length) state.envPrevious = { ...state.envPrevious, ...previous };
  const recorded = { ...owned };
  for (const [k, v] of Object.entries(addOnly)) {
    if (readEnvValue(paths.envFile, k) === null) recorded[k] = v;
    else if (k in state.env) recorded[k] = state.env[k]; // this tool added it in an earlier run
  }
  state.env = recorded;
  state.baseUrl = baseUrl;
  persist();
  const { changed } = updateEnvFile(paths.envFile, owned, addOnly);

  out('');
  out(`environment ${envId} (${region})`);
  out(`client id   ${app.id}`);
  out(`issuer      ${issuer}`);
  out(`audience    ${audience}`);
  out(`state file  ${paths.stateFile}`);
  out(`env file    ${paths.envFile} (${changed.length ? `wrote ${changed.join(', ')}` : 'already up to date'})`);
  return { exitCode: 0, state };
}

async function demoUser({ s, api, state, record, attempt, claimed, out }) {
  const fieldsFor = (user, populationId) => ({ id: user.id, username: DEMO_USERNAME, ...(UUID_RE.test(populationId ?? '') ? { populationId } : {}) });
  // The one and only place the password is shown. It is not in the state file, .env, a log or an error (api scrubs it from errors).
  const setAndShow = async (user, fields, label = 'created') => {
    const password = generatePassword();
    api.addSecret(password);
    await setUserPassword(s, user.id, password);
    record('user', fields, true); // the password is set: no longer pending
    out(`demo user ${label}: ${DEMO_USERNAME}  password: ${password}   (shown once; write it down now)`);
  };
  const existing = await findUser(s, DEMO_USERNAME);
  if (existing) {
    const prev = state.objects.user;
    const ours = prev?.id === existing.id && prev.created === true;
    const fields = fieldsFor(existing, prev?.populationId ?? existing.population?.id);
    if (ours && prev.passwordPending) return setAndShow(existing, fields, 'password set');
    if (!ours && claimed('user', { username: DEMO_USERNAME })) {
      // The create call's response was lost, so the user exists and its password was never set.
      record('user', { ...fields, passwordPending: true }, true);
      return setAndShow(existing, fields, 'password set');
    }
    record('user', fields, false);
    out(`demo user ${DEMO_USERNAME} already exists${ours ? ' (created by an earlier run; its password was shown once and is not stored)' : ' (not created by this tool; its password is unchanged)'}`);
    return undefined;
  }
  const population = await findDefaultPopulation(s);
  if (!population) throw new SafeError('the environment has no population to put the demo user in');
  const user = await attempt('user', { username: DEMO_USERNAME }, () => createUser(s, population.id));
  const fields = fieldsFor(user, population.id);
  record('user', { ...fields, passwordPending: true }, true); // recorded for teardown before the password call can fail
  return setAndShow(user, fields);
}

async function main() {
  let opts;
  try { opts = parseSetupArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n${USAGE}`); process.exit(2); }
  if (opts.help) { process.stdout.write(USAGE); return; }
  try { terminalOrThrow(); } catch (e) { printError(process.stderr, e); process.exit(1); }
  const result = await runSetup(opts, { prompt: createTerminalPrompt(), cwd: REPO_ROOT, env: process.env });
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
