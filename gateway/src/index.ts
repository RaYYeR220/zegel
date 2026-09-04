import { serve } from '@hono/node-server';

import { createGatewayApp } from './app.ts';
import { DEFAULT_STORE_PATH, loadConfig } from './config.ts';
import { buildHealthReport } from './health.ts';
import { createStatelessStore } from './store/factory.ts';
import { FileEnvelopeStore } from './store/file.ts';
import type { EnvelopeStore } from './store/types.ts';

const env = process.env;

// A long-running Node process has a disk, so `file` stays the default here. Every
// other backend comes from the shared factory, which the serverless entries use too.
const store: EnvelopeStore =
  (env['ZEGEL_STORE'] ?? 'file') === 'file'
    ? new FileEnvelopeStore(env['ZEGEL_STORE_PATH'] ?? DEFAULT_STORE_PATH)
    : createStatelessStore(env);

const config = loadConfig({ env, store });
const app = createGatewayApp(config);
const port = Number(env['ZEGEL_PORT'] ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`zegel-gateway listening on http://localhost:${info.port}`);
  console.log(`  signer      ${config.signer.address}`);
  console.log(`  store       ${config.store.kind} — ${config.store.description}`);
  console.log(`  serving     ${config.envelopeKey}`);
  console.log(
    `  resolvers   ${config.resolvers.length > 0 ? config.resolvers.join(', ') : 'unrestricted'}`,
  );
  for (const warning of config.warnings) console.warn(`  warning     ${warning}`);
});

// Probe once at boot so a broken deployment is visible in the logs immediately rather
// than the first time someone tries to resolve a name.
void buildHealthReport(config).then((report) => {
  if (report.status === 'ok') return;
  console.warn(`[zegel-gateway] health is ${report.status} at boot:`);
  for (const check of report.checks) {
    if (check.status === 'ok' || check.status === 'skipped') continue;
    console.warn(`  ${check.name}: ${check.status} — ${check.detail}`);
  }
});
