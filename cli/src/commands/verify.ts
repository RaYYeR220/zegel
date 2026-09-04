/**
 * `zegel verify` — what a counterparty is entitled to conclude.
 *
 * The command's whole value is refusing to round anything up. A self-consistent
 * envelope with no claim set behind it proves nothing and says so; a claim set
 * whose hash does not match is `tampered` and not "warning"; a 404 from Swarm is
 * `not-granted` and is explicitly reported as indistinguishable from "never
 * existed", because that indistinguishability is the privacy property.
 */

import { canonicalDigest } from '@zegel/sdk/canonical';
import { ENVELOPE_SCHEMA, type ClaimSet, type SealedEnvelope } from '@zegel/sdk/types';

import { CliError, type Output } from '../core/output.js';
import { assessReference, EXIT_FAILURE, type Assessment } from '../core/status.js';
import { DEFAULT_ETH_RPC } from '../core/probes.js';
import {
  DEFAULT_BASE_RPC,
  ZEGEL_ANCHOR_ADDRESS,
  anchorAddressFromEnv,
  anchorNote,
  readAnchor,
  type AnchorReading,
} from '../core/anchor.js';
import { renderAssessment, renderEnvelope } from '../render/envelope.js';
import { renderClaimSummary, renderClaims } from '../render/claims.js';
import { banner, field, section } from '../render/layout.js';
import { looksLikeName } from '../core/subject.js';

export interface VerifyOptions {
  /** Tier-1 claim set to recompute the commitment from. */
  claims?: string | undefined;
  /** ZegelAnchor address. Defaults to the deployed contract on Base mainnet. */
  anchor?: string | undefined;
  anchorRpc?: string | undefined;
  /** Do not touch the chain at all. The verdict then says revocation was not ruled out. */
  skipAnchor?: boolean | undefined;
  /** Mainnet RPC used when the target is an ENS name. */
  rpc?: string | undefined;
  /** Attempt to open a sealed tier, which is what produces a real `not-granted`. */
  open?: number | undefined;
  explain?: boolean | undefined;
  showClaims?: boolean | undefined;
}

export async function verify(out: Output, target: string, options: VerifyOptions = {}): Promise<number> {
  const theme = out.theme;
  out.lines(banner(theme, 'zegel verify', 'resolve, recompute, and report exactly what holds'));

  const loaded = await loadEnvelope(out, target, options);
  if (loaded.envelope === null) {
    const assessment = assessReference({
      envelope: null,
      now: new Date(),
      malformed: loaded.malformed ?? 'unreadable',
    });
    return finish(out, assessment, null, null, loaded.origin);
  }

  const envelope = loaded.envelope;
  if (!out.json) {
    out.lines(section(theme, 'the envelope'));
    out.line(field(theme, 'read from', loaded.origin));
    out.lines(renderEnvelope(theme, envelope));
  }

  // --- recompute the commitment -------------------------------------------
  const claimSet = await loadClaims(out, target, options);
  const commitment =
    claimSet === null
      ? ({ checked: false, reason: 'no claim set was supplied (pass --claims <file>)' } as const)
      : (() => {
          const recomputed = canonicalDigest(claimSet);
          return { checked: true, matches: recomputed === envelope.commitment, recomputed } as const;
        })();

  // --- on-chain anchor -----------------------------------------------------
  // Consulted by default: reading it needs no key and no funded account, and a
  // verification that skipped it could not tell a live reference from a revoked
  // one. An address in the envelope wins over the default, and an explicit
  // --anchor wins over both.
  const anchorAddress =
    options.skipAnchor === true
      ? undefined
      : (options.anchor ?? (envelope.revocationHint.contract || anchorAddressFromEnv()));
  const reading =
    anchorAddress === undefined || anchorAddress === ''
      ? null
      : await consultAnchor(out, anchorAddress, envelope, claimSet, options);

  // --- sealed tier ---------------------------------------------------------
  let tierRead: 'granted' | 'not-granted' | 'not-attempted' = 'not-attempted';
  if (options.open !== undefined) {
    tierRead = await openTier(out, envelope, options.open);
  }

  const note = reading === null ? undefined : anchorNote(reading);
  const assessment = assessReference({
    envelope,
    now: new Date(),
    anchor: reading?.status ?? null,
    ...(anchorAddress === undefined ? {} : { anchorAddress }),
    ...(note === undefined ? {} : { anchorNote: note }),
    commitment,
    tierRead,
  });

  if (!out.json && options.showClaims === true && claimSet !== null) {
    out.lines(section(theme, 'the claims you were shown'));
    out.lines(renderClaims(theme, claimSet.claims, { explain: options.explain === true }));
    out.lines(renderClaimSummary(theme, claimSet.claims));
  }

  return finish(out, assessment, envelope, claimSet, loaded.origin, reading);
}

function finish(
  out: Output,
  assessment: Assessment,
  envelope: SealedEnvelope | null,
  claimSet: ClaimSet | null,
  origin: string,
  anchor: AnchorReading | null = null,
): number {
  if (out.json) {
    out.emit({
      command: 'verify',
      origin,
      status: assessment.status,
      headline: assessment.headline,
      reasons: assessment.reasons,
      checks: assessment.checks,
      anchorChecked: assessment.anchorChecked,
      anchor,
      exitCode: assessment.exitCode,
      envelope,
      claimSet,
    });
    return assessment.exitCode;
  }

  out.lines(renderAssessment(out.theme, assessment));
  out.line();
  out.line(`  ${out.theme.dim(`exit code ${assessment.exitCode}`)}`);
  out.line();
  return assessment.exitCode;
}

// ---------------------------------------------------------------------------

/** RPC errors arrive as multi-line essays; a warning line wants the first sentence. */
function firstLine(message: string): string {
  return message.split(/\r?\n/)[0] ?? message;
}

interface LoadedEnvelope {
  envelope: SealedEnvelope | null;
  origin: string;
  malformed?: string;
}

async function loadEnvelope(
  out: Output,
  target: string,
  options: VerifyOptions,
): Promise<LoadedEnvelope> {
  const { readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const sdk = await import('@zegel/sdk');

  const isFile = existsSync(target);
  if (!isFile && looksLikeName(target)) {
    const rpcUrl = options.rpc;
    const { ethClient } = await import('../core/subject.js');
    const client = ethClient(rpcUrl);
    const where = rpcUrl ?? DEFAULT_ETH_RPC;
    try {
      const envelope = await sdk.resolveEnvelope(client, target);
      return { envelope, origin: `ENS ${target} via ${where}` };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof sdk.NoResolverError || cause instanceof sdk.NoEnvelopeError) {
        throw new CliError(message, {
          exitCode: EXIT_FAILURE,
          hints: [
            'The name resolves, but publishes no Zegel envelope under `zegel.envelope.v1`.',
            'Verify a local envelope instead: zegel verify .zegel/envelope.json',
          ],
        });
      }
      if (cause instanceof sdk.MalformedEnvelopeError) {
        return { envelope: null, origin: `ENS ${target}`, malformed: message };
      }
      // A reverting `data()` call and an unreachable RPC produce the same shape of
      // failure at the call site and completely different advice, so they are
      // separated here rather than being collapsed into "could not resolve".
      const name = cause instanceof Error ? cause.name : '';
      const reverted = name.startsWith('ContractFunction') || message.includes('reverted');
      throw new CliError(
        reverted
          ? `${target} resolves, but its resolver does not answer ENSIP-24 data()`
          : `could not reach the Ethereum RPC while resolving ${target}`,
        {
          cause,
          exitCode: EXIT_FAILURE,
          hints: reverted
            ? [
                'Only a resolver that implements ENSIP-24 `data(bytes32,string)` can publish a Zegel envelope.',
                'The ENS PublicResolver does not, so a plain name will always fail here.',
                'Verify a local envelope instead: zegel verify .zegel/envelope.json',
              ]
            : [`The RPC at ${where} did not answer. Set ETH_RPC_URL or pass --rpc.`],
        },
      );
    }
  }

  if (!isFile) {
    throw new CliError(`no file at ${target}, and it is not an ENS name`, {
      exitCode: EXIT_FAILURE,
      hints: ['Pass a path to an envelope.json, or an ENS name such as alice.eth.'],
    });
  }

  const text = await readFile(target, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return {
      envelope: null,
      origin: target,
      malformed: `${target} is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
    };
  }

  void out;
  const shaped = shapeEnvelope(parsed);
  return shaped.ok
    ? { envelope: shaped.envelope, origin: target }
    : { envelope: null, origin: target, malformed: shaped.reason };
}

/**
 * Shape-checks a local envelope, tolerating zero sealed tiers.
 *
 * `@zegel/sdk`'s `assertEnvelope` rejects an empty `tiers` array, which is right
 * for something resolved from ENS — publishing an envelope nobody can open would
 * be a bug. A local file is different: `zegel issue` against the public Swarm
 * gateway produces exactly that, because the gateway will not reveal its ACT
 * publisher key. Reporting that file as "not a Zegel envelope" would hide a real,
 * checkable commitment behind a wrong word, so the missing tier is reported as
 * the missing tier and the commitment is still verified.
 */
function shapeEnvelope(
  value: unknown,
): { ok: true; envelope: SealedEnvelope } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'not an object' };
  const e = value as Partial<SealedEnvelope>;
  if (e.schema !== ENVELOPE_SCHEMA) {
    return { ok: false, reason: `unknown schema ${String(e.schema)}` };
  }
  for (const key of ['referenceId', 'commitment', 'issuedAt', 'expiresAt'] as const) {
    if (typeof e[key] !== 'string') return { ok: false, reason: `missing ${key}` };
  }
  return {
    ok: true,
    envelope: {
      ...(e as SealedEnvelope),
      tiers: Array.isArray(e.tiers) ? e.tiers : [],
      anchors: e.anchors ?? {},
      revocationHint: e.revocationHint ?? { contract: '', chainId: 0 },
    },
  };
}

/**
 * Finds the tier-1 claim set.
 *
 * Auto-discovery is deliberately loud: a `claims.json` sitting next to the
 * envelope is picked up, and the fact that it was picked up is printed, because
 * a verification that silently pulled in a file the reader did not name would be
 * exactly the kind of convenience that hides a substitution.
 */
async function loadClaims(
  out: Output,
  target: string,
  options: VerifyOptions,
): Promise<ClaimSet | null> {
  const { readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');

  let path = options.claims;
  if (path === undefined && existsSync(target)) {
    const sibling = join(dirname(target), 'claims.json');
    if (existsSync(sibling)) {
      path = sibling;
      if (!out.json) out.warn(`using the claim set found next to the envelope: ${sibling}`);
    }
  }
  if (path === undefined) return null;

  try {
    return JSON.parse(await readFile(path, 'utf8')) as ClaimSet;
  } catch (cause) {
    throw new CliError(`could not read the claim set at ${path}`, { cause, exitCode: EXIT_FAILURE });
  }
}

/**
 * Asks the anchor contract about this reference.
 *
 * Returns `null` — meaning "not checked" — only when the chain could not be
 * reached, and says so out loud when that happens. An unreachable RPC and a
 * contract that answered "revoked" are different facts, and a verifier that
 * blurred them would be worse than one that never looked.
 */
async function consultAnchor(
  out: Output,
  anchorAddress: string,
  envelope: SealedEnvelope,
  claimSet: ClaimSet | null,
  options: VerifyOptions,
): Promise<AnchorReading | null> {
  // Ask about what the claim set actually hashes to, when we hold it: asking the
  // chain about the envelope's own commitment would let a doctored envelope vouch
  // for its own doctored claims.
  const commitment = claimSet === null ? envelope.commitment : canonicalDigest(claimSet);

  try {
    return await readAnchor(envelope.referenceId, commitment, {
      ...(options.anchorRpc === undefined ? {} : { rpcUrl: options.anchorRpc }),
      address: anchorAddress,
    });
  } catch (cause) {
    const where = options.anchorRpc ?? DEFAULT_BASE_RPC;
    const detail = cause instanceof Error ? firstLine(cause.message) : String(cause);
    out.warn(
      `the anchor at ${anchorAddress} could not be read over ${where} (${detail}); revocation was NOT checked`,
    );
    return null;
  }
}

/**
 * Opens a sealed tier, if the caller asked for it.
 *
 * A 404 is returned as `not-granted` rather than raised, and a configuration
 * fault — no publisher key, no backend — is raised rather than reported as a
 * privacy outcome. Collapsing those two would make the privacy claim untestable.
 */
async function openTier(
  out: Output,
  envelope: SealedEnvelope,
  tierNumber: number,
): Promise<'granted' | 'not-granted' | 'not-attempted'> {
  const tier = envelope.tiers.find((t) => t.tier === tierNumber);
  if (tier === undefined) {
    out.warn(`this envelope publishes no tier ${tierNumber}, so nothing was opened`);
    return 'not-attempted';
  }

  const seal = await import('@zegel/seal');
  try {
    const client = await seal.createSealClient({ kind: 'auto', keep: seal.memoryKeeper() });
    const result = await client.unseal(seal.coordinatesFromTier(tier));
    return result.granted ? 'granted' : 'not-granted';
  } catch (cause) {
    out.warn(
      `tier ${tierNumber} could not be opened for a reason that is not a refusal: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return 'not-attempted';
  }
}
