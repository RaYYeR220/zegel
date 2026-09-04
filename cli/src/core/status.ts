/**
 * What a verifier is actually entitled to conclude.
 *
 * Five outcomes carry different consequences for the person reading a reference,
 * and collapsing any two of them would be the whole product's failure mode:
 *
 *   tampered     the claims in front of you are not the claims that were sealed
 *   revoked      the issuer withdrew this reference
 *   expired      it aged out; nobody withdrew anything
 *   not-granted  Swarm answered 404, which is what a revoked *or* never-granted
 *                *or* never-existed read looks like — indistinguishable by design
 *   valid        every check that was run passed
 *
 * Plus two that say "I could not tell you", because a verifier that cannot check
 * something must never round it up to a pass:
 *
 *   unverifiable nothing checkable was available
 *   malformed    the envelope is not a Zegel envelope
 *
 * Pure, and the clock comes in as an argument, so the whole table is testable.
 */

import type { SealedEnvelope } from '@zegel/sdk/types';

export type ReferenceStatus =
  | 'valid'
  | 'expired'
  | 'revoked'
  | 'tampered'
  | 'not-granted'
  | 'unverifiable'
  | 'malformed';

/** Mirrors `@zegel/sdk`'s `AnchorStatus`, restated so this module stays pure and importable. */
export type AnchorOutcome =
  | 'never-anchored'
  | 'valid'
  | 'expired'
  | 'revoked'
  | 'commitment-mismatch';

export type CheckOutcome = 'pass' | 'fail' | 'skipped';

export interface Check {
  name: string;
  outcome: CheckOutcome;
  detail: string;
}

export interface AssessInput {
  envelope: SealedEnvelope | null;
  now: Date;
  /** `null` when no chain read was attempted, or when one was attempted and failed. */
  anchor?: AnchorOutcome | null | undefined;
  anchorAddress?: string | undefined;
  /** Extra context the contract supplied — issuer, expiry, revocation time. */
  anchorNote?: string | undefined;
  /** The result of recomputing the commitment from a claim set we actually hold. */
  commitment?:
    | { checked: true; matches: boolean; recomputed: string }
    | { checked: false; reason: string }
    | undefined;
  /** Whether a sealed tier was opened, and what Swarm said. */
  tierRead?: 'granted' | 'not-granted' | 'not-attempted' | undefined;
  /** Set when the input could not be parsed as an envelope at all. */
  malformed?: string | undefined;
}

export interface Assessment {
  status: ReferenceStatus;
  /** One line, safe to print as the headline. */
  headline: string;
  /** Why, in the reader's terms. Rendered under the headline. */
  reasons: readonly string[];
  checks: readonly Check[];
  exitCode: number;
  /** True when nothing on chain was consulted, so revocation could not be ruled out. */
  anchorChecked: boolean;
}

export const EXIT_CODES: Readonly<Record<ReferenceStatus, number>> = {
  valid: 0,
  expired: 2,
  revoked: 3,
  tampered: 4,
  'not-granted': 5,
  malformed: 6,
  unverifiable: 7,
};

/** Operational failure — an unreachable RPC, an unreadable file. Distinct from every verdict. */
export const EXIT_FAILURE = 1;

export function assessReference(input: AssessInput): Assessment {
  const checks: Check[] = [];
  const anchorChecked = input.anchor !== null && input.anchor !== undefined;

  if (input.malformed !== undefined || input.envelope === null) {
    return {
      status: 'malformed',
      headline: 'Not a Zegel envelope.',
      reasons: [input.malformed ?? 'no envelope could be read from the input'],
      checks: [{ name: 'envelope schema', outcome: 'fail', detail: input.malformed ?? 'unreadable' }],
      exitCode: EXIT_CODES.malformed,
      anchorChecked: false,
    };
  }

  const envelope = input.envelope;
  checks.push({
    name: 'envelope schema',
    outcome: 'pass',
    detail:
      envelope.tiers.length === 0
        ? `${envelope.schema}, no sealed tier published`
        : `${envelope.schema}, ${envelope.tiers.length} sealed tier(s)`,
  });

  // --- expiry --------------------------------------------------------------
  const expiresMs = Date.parse(envelope.expiresAt);
  const expired = Number.isFinite(expiresMs) && expiresMs <= input.now.getTime();
  checks.push(
    Number.isFinite(expiresMs)
      ? {
          name: 'expiry',
          outcome: expired ? 'fail' : 'pass',
          detail: expired
            ? `expired at ${envelope.expiresAt}`
            : `valid until ${envelope.expiresAt}`,
        }
      : { name: 'expiry', outcome: 'skipped', detail: `unreadable expiry: ${envelope.expiresAt}` },
  );

  // --- commitment ----------------------------------------------------------
  const commitment = input.commitment;
  if (commitment === undefined || commitment.checked === false) {
    checks.push({
      name: 'commitment',
      outcome: 'skipped',
      detail:
        commitment?.checked === false
          ? commitment.reason
          : 'no claim set was supplied, so the commitment could not be recomputed',
    });
  } else {
    checks.push({
      name: 'commitment',
      outcome: commitment.matches ? 'pass' : 'fail',
      detail: commitment.matches
        ? `recomputed ${commitment.recomputed} and it matches the envelope`
        : `recomputed ${commitment.recomputed}, envelope carries ${envelope.commitment}`,
    });
  }

  // --- anchor --------------------------------------------------------------
  if (!anchorChecked) {
    checks.push({
      name: 'on-chain anchor',
      outcome: 'skipped',
      detail:
        input.anchorAddress === undefined
          ? 'no anchor was consulted, so revocation could not be ruled out'
          : `${input.anchorAddress} could not be read, so revocation could not be ruled out`,
    });
  } else {
    const anchor = input.anchor as AnchorOutcome;
    const where = input.anchorAddress === undefined ? '' : ` at ${input.anchorAddress}`;
    const note = input.anchorNote === undefined ? '' : ` (${input.anchorNote})`;
    checks.push({
      name: 'on-chain anchor',
      outcome: anchor === 'valid' ? 'pass' : anchor === 'never-anchored' ? 'skipped' : 'fail',
      detail: `${anchor}${where}${note}`,
    });
  }

  // --- sealed tier ---------------------------------------------------------
  const tierRead = input.tierRead ?? 'not-attempted';
  checks.push({
    name: 'sealed tier',
    outcome: tierRead === 'granted' ? 'pass' : tierRead === 'not-granted' ? 'fail' : 'skipped',
    detail:
      tierRead === 'granted'
        ? 'opened with the configured grantee key'
        : tierRead === 'not-granted'
          ? 'Swarm returned 404: revoked, never granted, or never existed'
          : 'no read was attempted',
  });

  // --- verdict, in order of what matters most to the reader ----------------
  const commitmentMismatch = commitment?.checked === true && !commitment.matches;

  if (commitmentMismatch || input.anchor === 'commitment-mismatch') {
    return verdict(
      'tampered',
      'These are not the claims that were sealed.',
      commitmentMismatch
        ? [
            'Recomputing the commitment from the supplied claim set produced a different hash from the one the envelope carries. Do not rely on these claims.',
            ...(input.anchor === 'commitment-mismatch'
              ? ['The anchor contract independently reports a different commitment for this reference id.']
              : []),
          ]
        : [
            'The anchor contract holds a different commitment for this reference id than the one presented. Do not rely on these claims.',
            'That answer came from the chain, not from this tool: anyone can repeat the call and get the same number.',
          ],
    );
  }

  if (input.anchor === 'revoked') {
    return verdict('revoked', 'The issuer revoked this reference.', [
      'Revocation is observable on chain without decrypting anything.',
      'A grantee keeps whatever they already downloaded — revocation is forward-only.',
    ]);
  }

  if (expired || input.anchor === 'expired') {
    return verdict('expired', 'This reference has expired.', [
      `It was valid until ${envelope.expiresAt}.`,
      'Nobody withdrew it; it simply aged out. Ask the subject to issue a fresh one.',
    ]);
  }

  if (tierRead === 'not-granted') {
    return verdict('not-granted', 'You have no grant for this reference.', [
      'Swarm answered 404. That answer is identical for content you were never granted, content your grant was withdrawn from, and content that never existed.',
      'That indistinguishability is the privacy property, not a bug: nobody can probe for the existence of a reference they were not given.',
    ]);
  }

  const provedSomething =
    (commitment?.checked === true && commitment.matches) ||
    input.anchor === 'valid' ||
    tierRead === 'granted';

  if (!provedSomething) {
    return verdict('unverifiable', 'Nothing here could be checked.', [
      'The envelope parses and has not expired, but no claim set was supplied, no anchor was consulted and no sealed tier was opened.',
      'An envelope on its own is public, unauthenticated metadata. It is not evidence of anything.',
    ]);
  }

  const reasons = ['Every check that was run passed.'];
  if (input.anchor === 'valid') {
    reasons.push(
      'The anchor contract reports this reference as live: anchored, not expired, not revoked, and holding the commitment presented.',
    );
  }
  if (!anchorChecked) {
    reasons.push(
      input.anchorAddress === undefined
        ? 'No on-chain anchor was consulted, so revocation could not be ruled out.'
        : 'The anchor contract could not be read, so revocation could not be ruled out. This is a gap in the check, not a pass.',
    );
  } else if (input.anchor === 'never-anchored') {
    reasons.push(
      'The anchor contract has no record of this reference id, so revocation cannot be observed on chain.',
    );
  }
  if (envelope.tiers.length === 0) {
    reasons.push(
      'This envelope publishes no sealed tier, so there is nothing here for a grantee to open.',
    );
  }
  if (commitment === undefined || commitment.checked === false) {
    reasons.push(
      'No claim set was supplied, so nothing was checked about what the reference says — only about the reference itself. Pass --claims <file> to bind the two together.',
    );
  }
  return verdict('valid', 'Valid.', reasons);

  function verdict(
    status: ReferenceStatus,
    headline: string,
    reasons: readonly string[],
  ): Assessment {
    return {
      status,
      headline,
      reasons,
      checks,
      exitCode: EXIT_CODES[status],
      anchorChecked,
    };
  }
}
