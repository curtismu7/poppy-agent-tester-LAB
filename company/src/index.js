// Standalone entry: node company/src/index.js. Reads COMPANY_* from the environment (and the repo .env when present).
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFrom } from './config.js';
import { createCompanyApp } from './app.js';

try { process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env')); } catch { /* no .env: the environment is enough */ }

let config;
try { config = configFrom(process.env); } catch (err) {
  console.error(`company: ${err.message}`);
  process.exit(1);
}

const server = http.createServer(createCompanyApp({ config }));
server.listen(config.port, config.bind, () => {
  console.log(`company: ${config.origin} listening on ${config.bind}:${config.port}, issuer ${config.issuer}`);
});
