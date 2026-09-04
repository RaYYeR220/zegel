import 'server-only';

import {
  CLAIM_SPECS,
  buildEvidence,
  createMobulaClient,
  type MobulaClient,
} from '@zegel/evidence';
import { analyseExposure } from '@zegel/cli/exposure';
import type { EvidenceBundle } from '@zegel/sdk/types';

import { COLLECTION, MOBULA_API_KEY } from '../config';
import type { CollectProgressEvent, CreditMeter } from '../types';

export { analyseExposure };

/**
 * A fresh client per request.
 *
 * The credit meter belongs to the client, and the meter shown on screen has to be
 * the credits *this* collection spent — a process-wide client would show a number
 * accumulated by whoever else happened to hit the deployment.
 */
export function mobula(): MobulaClient {
  return createMobulaClient({
    ...(MOBULA_API_KEY === undefined ? {} : { apiKey: MOBULA_API_KEY }),
    // Three attempts, not five: a serverless function has a wall-clock budget,
    // and an endpoint that needs a fourth try is better reported unavailable. The
    // third is worth paying for because the demo host answers 429 under its own
    // rate limit, a 429 costs no credits, and the route that hits it most is
    // `/2/token/security` — the one carrying the risk-quality claim.
    retry: { maxAttempts: 3, timeoutMs: 9_000 },
  });
}

export function meter(client: MobulaClient): CreditMeter {
  return {
    spent: client.rateLimit.spent,
    latest: client.rateLimit.latest,
    host: client.baseUrl,
    keyed: client.hasApiKey,
  };
}

export interface CollectOptions {
  referenceId?: string;
  controlProof?: { message: string; signature: string; signer: string };
  onProgress?: (event: CollectProgressEvent) => void;
}

/** Collect the evidence a dossier or a reference is made of, live. */
export async function collect(
  client: MobulaClient,
  address: string,
  options: CollectOptions = {},
): Promise<EvidenceBundle> {
  return buildEvidence(address, {
    client,
    windowDays: COLLECTION.windowDays,
    maxSecurityLookups: COLLECTION.maxSecurityLookups,
    concurrency: COLLECTION.concurrency,
    historyLimit: COLLECTION.historyLimit,
    positionsLimit: COLLECTION.positionsLimit,
    tradesLimit: COLLECTION.tradesLimit,
    ...(options.referenceId === undefined ? {} : { referenceId: options.referenceId }),
    ...(options.controlProof === undefined ? {} : { controlProof: options.controlProof }),
    ...(options.onProgress === undefined
      ? {}
      : {
          onProgress: (event) => {
            options.onProgress?.({
              endpoint: event.endpoint,
              status: event.status,
              httpStatus: event.httpStatus,
              done: event.done,
              total: event.total,
            });
          },
        }),
  });
}

/**
 * Claims the derivation could not compute, and why.
 *
 * Shown as prominently as the ones that passed. A reference with eight claims and
 * a stated gap is worth more than one with ten claims and an invented number, and
 * a reader can only tell the difference if the gap is on the page.
 */
export function missingClaims(
  bundle: EvidenceBundle,
): { id: string; statement: string; reason: string }[] {
  const present = new Set(bundle.claims.map((claim) => claim.id));
  const unavailable = bundle.sources
    .filter((source) => source.unavailable !== undefined)
    .map((source) => source.endpoint);

  return CLAIM_SPECS.filter((spec) => !present.has(spec.id)).map((spec) => ({
    id: spec.id,
    statement: spec.statement,
    reason:
      unavailable.length > 0
        ? `no usable source: ${unavailable.join(', ')} did not answer`
        : 'the upstream answered, but carried nothing this claim can be computed from',
  }));
}
