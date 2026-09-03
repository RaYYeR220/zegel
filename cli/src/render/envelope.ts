/**
 * Envelope, seal-receipt and verdict rendering.
 *
 * The envelope is public by construction, so printing it in full is safe and is
 * the point: a reader should be able to see that it carries a commitment, an
 * expiry and three ACT coordinates, and nothing that identifies the subject.
 */

import type { SealedEnvelope } from '@zegel/sdk/types';

import type { Assessment, Check, ReferenceStatus } from '../core/status.js';
import { isoMinute, shortHex, wrap } from './format.js';
import { field, section, table } from './layout.js';
import type { Theme } from './theme.js';

export function renderEnvelope(theme: Theme, envelope: SealedEnvelope): string[] {
  const out: string[] = [];

  out.push(field(theme, 'schema', envelope.schema));
  out.push(field(theme, 'reference id', envelope.referenceId));
  out.push(field(theme, 'commitment', theme.bold(envelope.commitment)));
  out.push(field(theme, 'issued', isoMinute(envelope.issuedAt)));
  out.push(field(theme, 'expires', isoMinute(envelope.expiresAt)));
  out.push(
    field(
      theme,
      'revocation hint',
      envelope.revocationHint.contract === ''
        ? theme.dim('not anchored')
        : `${envelope.revocationHint.contract} ${theme.dim(`(chain ${envelope.revocationHint.chainId})`)}`,
    ),
  );

  if (envelope.tiers.length === 0) {
    out.push(field(theme, 'sealed tiers', theme.warn('none published')));
  } else {
    out.push('');
    out.push(
      ...table(
        theme,
        [
          { header: 'tier' },
          { header: 'swarm reference' },
          { header: 'act history address' },
          { header: 'act publisher' },
        ],
        envelope.tiers.map((tier) => [
          String(tier.tier),
          shortHex(tier.swarmRef, 12, 6),
          shortHex(tier.actHistoryAddress, 12, 6),
          shortHex(tier.actPublisher, 12, 6),
        ]),
      ).map((row) => `  ${row}`),
    );
  }

  const anchors: string[] = [];
  if (envelope.anchors.base !== undefined) {
    anchors.push(
      `Base ${envelope.anchors.base.chainId}: ${envelope.anchors.base.contract} tx ${shortHex(envelope.anchors.base.txHash)}`,
    );
  }
  if (envelope.anchors.solana !== undefined) {
    anchors.push(`Solana attestation ${envelope.anchors.solana.attestation}`);
  }
  out.push('');
  out.push(
    field(theme, 'on-chain anchors', anchors.length === 0 ? theme.dim('none') : anchors.join('; ')),
  );

  return out;
}

function paintStatus(theme: Theme, status: ReferenceStatus): string {
  switch (status) {
    case 'valid':
      return theme.good(`${theme.glyphs.pass} VALID`);
    case 'expired':
      return theme.warn(`${theme.glyphs.warn} EXPIRED`);
    case 'revoked':
      return theme.bad(`${theme.glyphs.fail} REVOKED`);
    case 'tampered':
      return theme.bad(`${theme.glyphs.fail} TAMPERED`);
    case 'not-granted':
      return theme.warn(`${theme.glyphs.warn} NOT GRANTED`);
    case 'unverifiable':
      return theme.warn(`${theme.glyphs.warn} UNVERIFIABLE`);
    case 'malformed':
      return theme.bad(`${theme.glyphs.fail} MALFORMED`);
  }
}

function paintCheck(theme: Theme, check: Check): string {
  switch (check.outcome) {
    case 'pass':
      return theme.good(theme.glyphs.pass);
    case 'fail':
      return theme.bad(theme.glyphs.fail);
    case 'skipped':
      return theme.dim('-');
  }
}

export function renderAssessment(theme: Theme, assessment: Assessment): string[] {
  const out: string[] = [];
  const width = Math.max(52, theme.width - 6);

  out.push('');
  out.push(`  ${paintStatus(theme, assessment.status)}  ${theme.bold(assessment.headline)}`);
  out.push('');
  for (const reason of assessment.reasons) {
    for (const line of wrap(reason, width)) out.push(`  ${line}`);
  }

  out.push(...section(theme, 'checks run'));
  for (const check of assessment.checks) {
    out.push(`  ${paintCheck(theme, check)} ${check.name.padEnd(18)} ${theme.dim(check.detail)}`);
  }

  return out;
}
