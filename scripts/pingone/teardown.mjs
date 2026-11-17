#!/usr/bin/env node
// Removes exactly what scripts/pingone/setup.mjs created (objects recorded with created:true in the state file), then
// the .env lines setup wrote (only while their value still matches), then the state file.
//   node scripts/pingone/teardown.mjs [--env-file .env] [--state-file .data/pingone-state.json] [--worker-env-id <uuid>]
// Asks for the worker client id and secret again (the secret is never stored). Needs a terminal.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  REPO_ROOT, REGIONS, SafeError, createApi, basesFor, checkUuid, resolvePaths, readState, removeState, removeEnvValues,
  parseTeardownArgs, createTerminalPrompt, terminalOrThrow, printError,
} from './lib.mjs';

const USAGE = `usage: node scripts/pingone/teardown.mjs [--env-file <path>] [--state-file <path>] [--worker-env-id <uuid>]
Prompts for the worker client id and worker client secret (no echo). Needs a terminal.
--worker-env-id: the environment the worker lives in; defaults to the one setup recorded, else the environment being torn down.
`;

export async function runTeardown(opts = {}, deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const out = (line = '') => stdout.write(`${line}\n`);
  try {
    return await teardown(opts, { ...deps, stdout, stderr }, out);
  } catch (e) {
    printError(stderr, e);
    return { exitCode: 1 };
  }
}

async function teardown(opts, deps, out) {
  const cwd = deps.cwd ?? REPO_ROOT;
  const prompt = deps.prompt;
  if (!prompt) throw new SafeError('no prompt available');
  const paths = resolvePaths({ cwd, env: deps.env ?? process.env, envFile: opts.envFile, stateFile: opts.stateFile });
  const state = readState(paths.stateFile);
  if (!state) { out(`nothing to tear down: no state file at ${paths.stateFile}`); return { exitCode: 0 }; }

  const o = state.objects;
  const rid = o.resource?.id;
  const aid = o.application?.id;
  // Order: demo user, grant, application, scope, resource. Only objects this tool created.
  const plan = [
    o.user?.created && { label: 'demo user', path: `/users/${o.user.id}` },
    o.grant?.created && aid && { label: 'grant', path: `/applications/${aid}/grants/${o.grant.id}` },
    o.application?.created && { label: 'application', path: `/applications/${aid}` },
    o.scope?.created && rid && { label: 'scope', path: `/resources/${rid}/scopes/${o.scope.id}` },
    o.resource?.created && { label: 'resource', path: `/resources/${rid}` },
  ].filter(Boolean);
  for (const [kind, obj] of Object.entries(o)) if (!obj.created) out(`keeping ${kind} ${obj.id} (not created by this tool)`);

  let failures = 0;
  if (plan.length) {
    const envId = checkUuid(state.environmentId, 'environment ID in the state file');
    // The region picks the host the worker secret is sent to, so a tampered state file must not choose it freely.
    if (!REGIONS.includes(state.region)) throw new SafeError(`region in the state file is not one of ${REGIONS.join(', ')}`);
    out(`environment ${envId} (${state.region})`);
    const workerId = checkUuid(await prompt.ask('Worker client ID: '), 'worker client ID');
    const secret = await prompt.secret('Worker client secret (hidden): ');
    if (!secret) throw new SafeError('the worker client secret is empty');
    const bases = deps.bases ?? basesFor(state.region);
    const api = createApi({ authBase: bases.auth, apiBase: bases.api, fetchImpl: deps.fetch ?? fetch });
    const workerEnvId = opts.workerEnvId === undefined ? state.workerEnvironmentId ?? envId : checkUuid(opts.workerEnvId, '--worker-env-id');
    const s = api.session(envId, await api.mintToken(workerEnvId, workerId, secret));
    for (const step of plan) {
      try {
        const result = await s.del(step.path);
        out(`${step.label} ${result === 'gone' ? 'already gone' : 'deleted'}`);
      } catch (e) {
        failures += 1;
        deps.stderr.write(`error: could not delete ${step.label}: ${e?.name === 'SafeError' ? e.message : `unexpected failure (${e?.code || e?.name})`}\n`);
      }
    }
  }

  if (failures) {
    out(`${failures} object(s) could not be removed; the state file and .env lines are kept so you can run teardown again`);
    return { exitCode: 1 };
  }
  const { removed, restored } = removeEnvValues(paths.envFile, state.env, state.envPrevious ?? {});
  removeState(paths.stateFile);
  out(`removed env lines: ${removed.length ? removed.join(', ') : 'none (missing or changed since setup)'}`);
  if (restored.length) out(`restored the lines setup had replaced: ${restored.join(', ')}`);
  out('state file removed');
  return { exitCode: 0 };
}

async function main() {
  let opts;
  try { opts = parseTeardownArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n${USAGE}`); process.exit(2); }
  if (opts.help) { process.stdout.write(USAGE); return; }
  try { terminalOrThrow(); } catch (e) { printError(process.stderr, e); process.exit(1); }
  const result = await runTeardown(opts, { prompt: createTerminalPrompt(), cwd: REPO_ROOT, env: process.env });
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
