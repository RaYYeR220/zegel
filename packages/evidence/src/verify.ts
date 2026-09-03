import { BUNDLE_SCHEMA, canonicalDigest, canonicalize, digestsEqual } from './sdk.js';
import type { Claim, EvidenceBundle } from './sdk.js';
import { DERIVATION_ID, deriveClaims } from './derive.js';

/**
 * The negative control.
 *
 * The trust model of this product is "do not trust the issuer, re-run the
 * derivation". This function is that re-run: it recomputes every claim from the
 * raw bodies the bundle carries and reports anything that does not match. A
 * bundle that has been edited — a number nudged, a claim flipped, a source
 * swapped — fails here, and so does one produced by a different set of rules.
 */

export interface VerifyResult {
  ok: boolean;
  /** Human-readable, one line per discrepancy. Empty when `ok`. */
  mismatches: string[];
  /** Claims recomputed from `sources[].body`. */
  recomputed: Claim[];
}

export function verifyClaims(bundle: EvidenceBundle): VerifyResult {
  const mismatches: string[] = [];

  if (bundle.schema !== BUNDLE_SCHEMA) {
    mismatches.push(`schema: expected ${BUNDLE_SCHEMA}, bundle says ${String(bundle.schema)}`);
  }

  // A bundle scored by different rules is not comparable to one scored by these,
  // so it is rejected rather than re-scored under ours.
  if (!digestsEqual(bundle.derivationId, DERIVATION_ID)) {
    mismatches.push(
      `derivationId: bundle was produced by ${bundle.derivationId}, this build derives ${DERIVATION_ID}`,
    );
    return { ok: false, mismatches, recomputed: [] };
  }

  // Every stored digest must still describe its stored body. This catches an
  // edit to a raw response even before the derivation runs.
  for (const source of bundle.sources) {
    if (source.unavailable !== undefined) {
      if (source.body !== undefined) {
        mismatches.push(`source ${source.index}: marked unavailable but carries a body`);
      }
      continue;
    }
    if (source.body === undefined) continue;
    const digest = canonicalDigest(source.body);
    if (!digestsEqual(digest, source.digest)) {
      mismatches.push(
        `source ${source.index} (${source.endpoint}): digest ${source.digest} does not match its body (${digest})`,
      );
    }
  }

  const recomputed = deriveClaims(bundle);
  const stated = new Map(bundle.claims.map((c) => [c.id, c]));
  const derived = new Map(recomputed.map((c) => [c.id, c]));

  for (const id of derived.keys()) {
    if (!stated.has(id)) mismatches.push(`claim ${id}: derivable from the sources but absent`);
  }
  for (const id of stated.keys()) {
    if (!derived.has(id)) {
      mismatches.push(`claim ${id}: asserted but cannot be derived from the sources`);
    }
  }

  for (const [id, expected] of derived) {
    const actual = stated.get(id);
    if (actual === undefined) continue;
    for (const field of ['statement', 'op', 'unit', 'passed', 'actual', 'threshold', 'sources'] as const) {
      const a = canonicalize(actual[field] ?? null);
      const b = canonicalize(expected[field] ?? null);
      if (a !== b) mismatches.push(`claim ${id}.${field}: bundle says ${a}, sources give ${b}`);
    }
  }

  return { ok: mismatches.length === 0, mismatches, recomputed };
}
