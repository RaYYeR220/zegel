/**
 * `zegel issue` — collect, derive, seal, publish.
 *
 * The command deliberately prints failed claims as loudly as passed ones. A
 * reference that only ever flatters its subject is worth nothing to the person
 * reading it, and the derivation has no way to be persuaded — so the honest
 * output is the feature, not an embarrassment to hide behind a filter.
 */

import { CLAIM_SPECS, buildEvidence, commitmentFor, createMobulaClient, toClaimSet, verifyClaims } from '@zegel/evidence';
import type { ClaimSet, EvidenceBundle, SealedEnvelope, SealedTier } from '@zegel/sdk/types';
import { ENVELOPE_SCHEMA } from '@zegel/sdk/types';

import { CliError, type Output } from '../core/output.js';
import { resolveSubject } from '../core/subject.js';
import { renderClaimSummary, renderClaims, renderMissingClaims } from '../render/claims.js';
import { renderEnvelope } from '../render/envelope.js';
import { banner, bullet, field, section } from '../render/layout.js';
import { DEFAULT_WINDOW_DAYS, parseChains } from './scan.js';

export interface IssueOptions {
  chains?: string | undefined;
  days?: number | undefined;
  maxSecurity?: number | undefined;
  concurrency?: number | undefined;
  expiresDays?: number | undefined;
  /** Reuse a bundle written by `scan --out`, instead of collecting again. */
  bundle?: string | undefined;
  /** Compressed secp256k1 public keys to grant at seal time. Needs a Bee node. */
  grant?: string[] | undefined;
  seal?: boolean | undefined;
  out?: string | undefined;
  emitBundle?: boolean | undefined;
  explain?: boolean | undefined;
  anchor?: string | undefined;
  anchorChain?: number | undefined;
  rpc?: string | undefined;
}

const DEFAULT_OUT_DIR = '.zegel';
const DEFAULT_EXPIRY_DAYS = 30;

export async function issue(
  out: Output,
  target: string | undefined,
  options: IssueOptions = {},
): Promise<number> {
  const theme = out.theme;
  const outDir = options.out ?? DEFAULT_OUT_DIR;
  const { writeFile, mkdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  out.lines(banner(theme, 'zegel issue', 'derive claims from live data, seal them, publish a commitment'));

  // --- evidence ------------------------------------------------------------
  let bundle: EvidenceBundle;
  let creditsSpent = 0;

  if (options.bundle !== undefined) {
    const text = await readFile(options.bundle, 'utf8').catch((cause: unknown) => {
      throw new CliError(`could not read the bundle at ${options.bundle}`, { cause });
    });
    bundle = JSON.parse(text) as EvidenceBundle;
    out.line();
    out.line(`  ${theme.dim(`reusing the evidence bundle at ${options.bundle}`)}`);
  } else {
    if (target === undefined) {
      throw new CliError('issue needs a subject: an address, an ENS name, or --bundle <file>', {
        hints: [
          'zegel issue vitalik.eth',
          'zegel issue --bundle .zegel/bundle.json   (reuses evidence from `zegel scan --out`)',
        ],
      });
    }
    const subject = await resolveSubject(target, { rpcUrl: options.rpc });
    const client = createMobulaClient({ retry: { maxAttempts: 2, timeoutMs: 8_000 } });
    out.line();
    out.line(
      `  ${theme.dim(`collecting from ${client.baseUrl}${client.hasApiKey ? ' with a key' : ' — no key, no signup'}`)}`,
    );
    bundle = await buildEvidence(subject.address, {
      client,
      chains: parseChains(options.chains),
      windowDays: options.days ?? DEFAULT_WINDOW_DAYS,
      maxSecurityLookups: options.maxSecurity ?? 10,
      concurrency: options.concurrency ?? 4,
      onProgress: (event) => {
        out.progress(`[${event.done}/${event.total}] ${event.endpoint} ${event.status}`);
      },
    });
    out.endProgress();
    creditsSpent = client.rateLimit.spent;
    if (subject.ensName !== undefined && !out.json) {
      out.line(`  ${theme.dim(`${subject.ensName} resolves to ${subject.address}`)}`);
    }
  }

  const claimSet: ClaimSet = toClaimSet(bundle);
  const commitment = commitmentFor(bundle);
  const control = verifyClaims(bundle);

  // --- render the claims ---------------------------------------------------
  if (!out.json) {
    out.lines(section(theme, 'the claims'));
    out.line(
      `  ${theme.dim(`derivation ${bundle.derivationId}`)}`,
    );
    out.line();
    out.lines(
      renderClaims(theme, bundle.claims, {
        showActual: true,
        ...(options.explain === true ? { explain: true, sources: bundle.sources } : {}),
      }),
    );
    out.lines(renderClaimSummary(theme, bundle.claims));
    out.lines(
      renderMissingClaims(
        theme,
        bundle.claims,
        CLAIM_SPECS.map((spec) => spec.id),
      ),
    );

    out.lines(section(theme, 'negative control'));
    out.line(
      control.ok
        ? `  ${theme.good(theme.glyphs.pass)} re-deriving every claim from the stored upstream bodies reproduces this claim set exactly`
        : `  ${theme.bad(theme.glyphs.fail)} re-derivation does not reproduce this claim set`,
    );
    for (const mismatch of control.mismatches) out.lines([bullet(theme, theme.bad(mismatch))]);
    out.line(
      `  ${theme.dim('A grantee runs the same function against the same bodies. They do not have to trust us.')}`,
    );
  }

  // --- sealing -------------------------------------------------------------
  const grantees = options.grant ?? [];
  const sealResult =
    options.seal === false
      ? null
      : await sealTiers(out, bundle, claimSet, grantees, join(outDir, 'receipts.jsonl'));

  const tiers: SealedTier[] = sealResult?.tiers ?? [];

  // --- the envelope --------------------------------------------------------
  const issuedAt = new Date();
  const expiresAt = new Date(
    issuedAt.getTime() + (options.expiresDays ?? DEFAULT_EXPIRY_DAYS) * 86_400_000,
  );
  const envelope: SealedEnvelope = {
    schema: ENVELOPE_SCHEMA,
    referenceId: bundle.referenceId,
    commitment,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    tiers,
    anchors: {},
    revocationHint: {
      contract: options.anchor ?? '',
      chainId: options.anchorChain ?? 8453,
    },
  };

  // --- write the artefacts -------------------------------------------------
  await mkdir(outDir, { recursive: true });
  const envelopePath = join(outDir, 'envelope.json');
  const claimsPath = join(outDir, 'claims.json');
  await writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  await writeFile(claimsPath, `${JSON.stringify(claimSet, null, 2)}\n`, 'utf8');
  const bundlePath = options.emitBundle === true ? join(outDir, 'bundle.json') : null;
  if (bundlePath !== null) {
    await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  }

  if (out.json) {
    out.emit({
      command: 'issue',
      subject: { address: bundle.subject.address, chains: bundle.subject.chains },
      window: bundle.window,
      derivationId: bundle.derivationId,
      commitment,
      claims: bundle.claims,
      claimSet,
      negativeControl: control,
      credits: { spent: creditsSpent },
      seal: sealResult?.json ?? { attempted: options.seal !== false, tiers: [] },
      envelope,
      files: {
        envelope: envelopePath,
        claims: claimsPath,
        ...(bundlePath === null ? {} : { bundle: bundlePath }),
      },
    });
    return sealResult?.failed === true ? 1 : 0;
  }

  out.lines(section(theme, 'the envelope'));
  out.line(
    `  ${theme.dim('This is the public part. It says a reference exists, when it expires and where the')}`,
  );
  out.line(`  ${theme.dim('ciphertext lives. It carries no address and no claim text.')}`);
  out.line();
  out.lines(renderEnvelope(theme, envelope));

  out.lines(section(theme, 'written'));
  out.line(field(theme, 'envelope', envelopePath));
  out.line(field(theme, 'tier-1 claim set', claimsPath));
  if (bundlePath !== null) {
    out.line(field(theme, 'tier-2 bundle', `${bundlePath} ${theme.warn('(contains the address)')}`));
  }
  out.line();
  out.line(`  ${theme.dim('Verify it back:')} ${theme.bold(`zegel verify ${envelopePath}`)}`);
  out.line();

  return sealResult?.failed === true ? 1 : 0;
}

// ---------------------------------------------------------------------------

interface SealOutcome {
  tiers: SealedTier[];
  /**
   * Non-zero exit territory: the caller asked for something and did not get it.
   *
   * Deliberately *not* set when a tier sealed but cannot be published — that is a
   * property of the backend the environment happens to have, it is stated in full
   * on screen, and the claims and commitment above it are real either way. A
   * judge on a laptop with no Bee node should get an honest partial result, not a
   * failed command.
   */
  failed: boolean;
  /** Tiers that went to Swarm but cannot go into the envelope. */
  unpublishable: number;
  json: unknown;
}

/**
 * Seals both tiers and reports exactly what the backend could and could not do.
 *
 * The gateway path seals but cannot publish: it never exposes its own public key,
 * so the ACT publisher is unknown and a tier record built from it would point at
 * something nobody can open. That is reported, and the tier is left out of the
 * envelope rather than filled with a plausible-looking wrong value.
 */
async function sealTiers(
  out: Output,
  bundle: EvidenceBundle,
  claimSet: ClaimSet,
  grantees: readonly string[],
  receiptsPath: string,
): Promise<SealOutcome> {
  const theme = out.theme;
  const seal = await import('@zegel/seal');

  if (!out.json) out.lines(section(theme, 'sealing'));

  let client: Awaited<ReturnType<typeof seal.createSealClient>>;
  try {
    client = await seal.createSealClient({
      kind: 'auto',
      keep: seal.fileKeeper(receiptsPath),
      onWarning: (message) => out.warn(message),
    });
  } catch (cause) {
    if (!out.json) {
      out.line(`  ${theme.bad(theme.glyphs.fail)} no Swarm backend answered`);
      out.line(`  ${theme.dim(cause instanceof Error ? cause.message : String(cause))}`);
      out.line(`  ${theme.dim('The claims above are still derived and the commitment above is still real.')}`);
      out.line(`  ${theme.dim('Nothing was sealed, so nothing can be granted. Run `zegel doctor`.')}`);
    }
    return {
      tiers: [],
      failed: true,
      unpublishable: 0,
      json: { attempted: true, error: String(cause), tiers: [] },
    };
  }

  const caps = client.caps;
  if (!out.json) {
    out.line(field(theme, 'backend', `${caps.kind} at ${caps.url}`));
    out.line(
      field(
        theme,
        'confidentiality',
        caps.confidentiality === 'key-bound'
          ? theme.good('key-bound (grantees decrypt with their own key)')
          : theme.warn('obscurity (the gateway operator holds the publisher key)'),
      ),
    );
    out.line(field(theme, 'grantee management', caps.canManageGrantees ? theme.good('available') : theme.warn('unavailable')));
    for (const limitation of caps.limitations) out.lines([bullet(theme, theme.dim(limitation))]);
    out.line();
  }

  if (grantees.length > 0 && !caps.canManageGrantees) {
    if (!out.json) {
      out.line(`  ${theme.bad(theme.glyphs.fail)} ${grantees.length} grantee key(s) were requested, and this backend cannot apply them.`);
      out.line(`  ${theme.dim(`POST /grantee is not exposed by ${caps.url}. Nothing was sealed, because sealing`)}`);
      out.line(`  ${theme.dim('an object and telling you it was granted would be a lie.')}`);
      out.line(`  ${theme.dim('Start a Bee node and set ZEGEL_BEE_URL, or drop --grant and seal to the publisher only.')}`);
    }
    return {
      tiers: [],
      failed: true,
      unpublishable: 0,
      json: { attempted: true, error: 'grantee management unavailable', backend: caps, tiers: [] },
    };
  }

  const receipts: unknown[] = [];
  const tiers: SealedTier[] = [];
  let failed = false;
  let unpublishable = 0;

  for (const [tier, payload] of [
    [1, claimSet],
    [2, bundle],
  ] as const) {
    try {
      const receipt = await client.seal(payload, grantees, {
        referenceId: bundle.referenceId,
        tier,
      });
      receipts.push(receipt);

      if (seal.isReadable(receipt)) {
        tiers.push(seal.toSealedTier(receipt));
        if (!out.json) {
          out.line(
            `  ${theme.good(theme.glyphs.pass)} tier ${tier} sealed — ${receipt.bytes} bytes, ref ${receipt.swarmRef.slice(0, 16)}…`,
          );
          out.line(`    ${theme.dim(`act history ${receipt.actHistoryAddress}`)}`);
        }
      } else {
        unpublishable += 1;
        if (!out.json) {
          out.line(
            `  ${theme.warn(theme.glyphs.warn)} tier ${tier} sealed, but cannot be published`,
          );
          out.line(
            `    ${theme.dim(`${caps.url} does not expose its ACT publisher key, so no reader could open it.`)}`,
          );
          out.line(`    ${theme.dim(`ref ${receipt.swarmRef}`)}`);
          out.line(`    ${theme.dim(`act history ${receipt.actHistoryAddress}`)}`);
          out.line(`    ${theme.dim('Set ZEGEL_ACT_PUBLISHER, or seal through a Bee node you control.')}`);
        }
      }
    } catch (cause) {
      failed = true;
      if (!out.json) {
        out.line(`  ${theme.bad(theme.glyphs.fail)} tier ${tier} was not sealed`);
        out.line(`    ${theme.dim(cause instanceof Error ? cause.message : String(cause))}`);
      }
      receipts.push({ tier, error: String(cause) });
    }
  }

  if (!out.json) {
    out.line();
    out.line(`  ${theme.dim(`receipts appended to ${receiptsPath} — the ACT history address cannot be recovered if lost`)}`);
  }

  if (!out.json && unpublishable > 0) {
    out.line();
    out.line(
      `  ${theme.warn(theme.glyphs.warn)} ${unpublishable} of 2 tiers cannot go into the envelope, so the envelope will publish ${tiers.length} tier(s).`,
    );
    out.line(
      `  ${theme.dim('The claims and the commitment above are real regardless: the commitment is a hash of')}`,
    );
    out.line(
      `  ${theme.dim('the claim set, not of anything Swarm returned. What is missing is a reader path.')}`,
    );
  }

  return {
    tiers,
    failed,
    unpublishable,
    json: { attempted: true, backend: caps, receipts, grantees, publishedTiers: tiers.length, unpublishable },
  };
}
