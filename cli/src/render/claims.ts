/**
 * Claim rendering.
 *
 * A claim is a sentence plus an assertion, and both have to survive the trip to a
 * terminal: the sentence is what a non-crypto reader acts on, the assertion is
 * what a technical reader checks. The measured value is printed only when the
 * caller actually holds it — a tier-1 claim set has no `actual`, and inventing a
 * dash-shaped placeholder that looks like a value would be worse than the gap.
 */

import type { Claim, EvidenceSource } from '@zegel/sdk/types';

import { inUnit, opWords, shortHex, thresholdIn, wrap } from './format.js';
import { section } from './layout.js';
import type { Theme } from './theme.js';

export interface ClaimRenderOptions {
  /** Print the measured value where the claim carries one. */
  showActual?: boolean;
  /** Print the upstream endpoints, parameters and digests behind each claim. */
  explain?: boolean;
  sources?: readonly EvidenceSource[];
}

export function renderClaims(
  theme: Theme,
  claims: readonly Claim[],
  options: ClaimRenderOptions = {},
): string[] {
  const out: string[] = [];
  const width = Math.max(48, theme.width - 8);
  const sources = options.sources ?? [];

  for (const claim of claims) {
    const mark = claim.passed
      ? theme.good(theme.glyphs.pass)
      : theme.bad(theme.glyphs.fail);
    const verdict = claim.passed ? theme.good('met') : theme.bad('not met');
    out.push(`  ${mark} ${theme.bold(claim.id)} ${theme.dim('—')} ${verdict}`);

    for (const line of wrap(claim.statement, width)) out.push(`      ${line}`);

    const asserts = `asserts ${opWords(claim.op)} ${thresholdIn(claim.threshold, claim.unit)}`;
    const measured =
      options.showActual === true && claim.actual !== undefined
        ? `measured ${theme.bold(inUnit(claim.actual, claim.unit))} ${theme.dim(`(${claim.unit})`)}`
        : theme.dim('measured value withheld at this tier');
    out.push(`      ${measured} ${theme.dim(theme.glyphs.bullet)} ${theme.dim(asserts)}`);

    if (options.explain === true) {
      for (const index of claim.sources) {
        const source = sources.find((s) => s.index === index);
        if (source === undefined) {
          out.push(`      ${theme.dim(`${theme.glyphs.arrow} source[${index}] (not in this payload)`)}`);
          continue;
        }
        const params = Object.entries(source.params)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(' ');
        out.push(
          `      ${theme.dim(`${theme.glyphs.arrow} ${source.endpoint} ${params}`)}`,
        );
        out.push(
          `        ${theme.dim(`digest ${shortHex(source.digest)} fetched ${source.fetchedAt}`)}`,
        );
      }
    }
    out.push('');
  }

  return out;
}

export function claimTally(claims: readonly Claim[]): { passed: number; failed: number; total: number } {
  const passed = claims.filter((c) => c.passed).length;
  return { passed, failed: claims.length - passed, total: claims.length };
}

export function renderClaimSummary(theme: Theme, claims: readonly Claim[]): string[] {
  const { passed, failed, total } = claimTally(claims);
  const verdict =
    failed === 0
      ? theme.good(`all ${total} claims met`)
      : `${theme.good(`${passed} met`)} ${theme.dim('/')} ${theme.bad(`${failed} not met`)} ${theme.dim(`of ${total}`)}`;
  return [`  ${verdict}`];
}

/**
 * Claims the derivation could not compute at all.
 *
 * A missing claim is not a failed claim, and the difference is the whole reason
 * this product is worth trusting: a reference with an honest gap beats one with
 * an invented number.
 */
export function renderMissingClaims(
  theme: Theme,
  emitted: readonly Claim[],
  allIds: readonly string[],
): string[] {
  const present = new Set(emitted.map((c) => c.id));
  const missing = allIds.filter((id) => !present.has(id));
  if (missing.length === 0) return [];

  return [
    ...section(theme, 'could not be computed'),
    `  ${theme.dim('These claims were omitted because their upstream source was unavailable.')}`,
    `  ${theme.dim('They are absent, not failed — no default was substituted.')}`,
    '',
    ...missing.map((id) => `  ${theme.warn(theme.glyphs.warn)} ${id}`),
  ];
}
