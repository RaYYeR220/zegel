/**
 * `zegel grant` and `zegel revoke`.
 *
 * These are the two commands that cannot be faked. Grantee-list management lives
 * behind `POST /grantee`, which the public Swarm gateway answers with 404, and
 * the ACT publisher private key has to be one we hold. Without a Bee node there
 * is no honest degraded mode — so this refuses, says precisely what is missing,
 * and exits non-zero. It never reports a grant that did not happen.
 */

import { CliError, type Output } from '../core/output.js';
import { DEFAULT_BEE_URL } from '../core/probes.js';
import { bullet, banner, field, section } from '../render/layout.js';

export interface GranteeOptions {
  /** Receipt log written by `zegel issue`. */
  receipts?: string | undefined;
  /** Which sealed tier to patch. */
  tier?: number | undefined;
  /** Restrict to one reference when the log holds several. */
  reference?: string | undefined;
  beeUrl?: string | undefined;
}

const DEFAULT_RECEIPTS = '.zegel/receipts.jsonl';

export async function grantee(
  out: Output,
  action: 'grant' | 'revoke',
  pubkeys: readonly string[],
  options: GranteeOptions = {},
): Promise<number> {
  const theme = out.theme;
  const beeUrl = options.beeUrl ?? process.env['ZEGEL_BEE_URL'] ?? process.env['BEE_API_URL'] ?? DEFAULT_BEE_URL;
  const receiptsPath = options.receipts ?? DEFAULT_RECEIPTS;

  out.lines(
    banner(
      theme,
      `zegel ${action}`,
      action === 'grant'
        ? 'add a reader to a sealed tier, by public key'
        : 'cut a reader off from every version sealed from here on',
    ),
  );

  const seal = await import('@zegel/seal');

  // --- validate the keys before touching anything --------------------------
  const keys = pubkeys.map((raw) => {
    const key = seal.tryGranteePublicKey(raw.trim());
    if (key === null) {
      throw new CliError(`"${raw}" is not a compressed secp256k1 public key`, {
        hints: [
          'A grantee is 66 hex characters starting 02 or 03 — a public key, not an address.',
          'An Ethereum address is a hash and cannot take part in the key exchange ACT uses.',
        ],
      });
    }
    return key;
  });

  // --- the node has to exist -----------------------------------------------
  const reachable = await nodeAnswers(beeUrl);
  if (!reachable.ok) {
    return refuse(out, action, beeUrl, reachable.detail);
  }

  // --- the receipts have to exist ------------------------------------------
  const { existsSync } = await import('node:fs');
  if (!existsSync(receiptsPath)) {
    throw new CliError(`no seal receipts at ${receiptsPath}`, {
      hints: [
        'Grantee lists are patched against a specific sealed object, identified by its receipt.',
        'Run `zegel issue <address>` first, or pass --receipts <path>.',
      ],
    });
  }

  const receipts = await seal.readKeptReceipts(receiptsPath);
  const tier = options.tier ?? 2;
  const candidates = receipts.filter(
    (r) =>
      r.tier === tier &&
      (options.reference === undefined || r.referenceId === options.reference),
  );
  const receipt = candidates.at(-1);
  if (receipt === undefined) {
    throw new CliError(
      `no tier-${tier} receipt${options.reference === undefined ? '' : ` for ${options.reference}`} in ${receiptsPath}`,
      {
        hints: [`The log holds ${receipts.length} receipt(s). Pass --tier or --reference to pick one.`],
      },
    );
  }

  // --- connect and patch ---------------------------------------------------
  let client: Awaited<ReturnType<typeof seal.createSealClient>>;
  try {
    client = await seal.createSealClient({
      kind: 'node',
      url: beeUrl,
      keep: seal.fileKeeper(receiptsPath),
      onWarning: (message) => out.warn(message),
    });
  } catch (cause) {
    return refuse(out, action, beeUrl, cause instanceof Error ? cause.message : String(cause));
  }

  if (!client.caps.canManageGrantees) {
    return refuse(out, action, beeUrl, 'the backend does not expose POST /grantee');
  }

  if (!out.json) {
    out.lines(section(theme, 'target'));
    out.line(field(theme, 'bee node', client.caps.url));
    out.line(field(theme, 'reference', receipt.referenceId));
    out.line(field(theme, 'tier', String(receipt.tier)));
    out.line(field(theme, 'swarm reference', receipt.swarmRef));
    out.line(field(theme, 'act history (before)', receipt.actHistoryAddress));
    out.line(field(theme, 'keys', String(keys.length)));
    out.line();
    out.line(
      `  ${theme.dim('Grantee patches are serialised with a 1.1 s floor: Bee keys each history version on')}`,
    );
    out.line(`  ${theme.dim('the wall-clock second, so two writes inside one second collide and fail.')}`);
  }

  const started = Date.now();
  let result: Awaited<ReturnType<typeof client.grant>>;
  try {
    result = action === 'grant' ? await client.grant(receipt, keys) : await client.revoke(receipt, keys);
  } catch (cause) {
    throw new CliError(`the ${action} was rejected by ${client.caps.url}`, {
      cause,
      hints: ['Nothing changed. The grantee list is exactly as it was before this command ran.'],
    });
  }

  if (out.json) {
    out.emit({
      command: action,
      beeUrl: client.caps.url,
      referenceId: receipt.referenceId,
      tier: receipt.tier,
      keys,
      result,
      elapsedMs: Date.now() - started,
    });
    return 0;
  }

  out.lines(section(theme, 'result'));
  out.line(`  ${theme.good(theme.glyphs.pass)} ${action === 'grant' ? 'granted' : 'revoked'} ${keys.length} key(s) in ${Date.now() - started} ms`);
  for (const key of keys) {
    out.lines([bullet(theme, `${key} ${theme.dim(`(address ${seal.granteeAddress(key)})`)}`)]);
  }
  out.line();
  out.line(field(theme, 'act history (after)', result.actHistoryAddress));
  out.line(field(theme, 'grantee list ref', result.granteeListRef));
  out.line();

  if (result.rotationRequired) {
    out.lines(section(theme, 'what revocation actually did'));
    out.line(`  ${theme.warn(theme.glyphs.warn)} Revocation is forward-only, and this is the honest version:`);
    out.line();
    out.lines([
      bullet(theme, 'The removed key can no longer open versions sealed from here on.'),
      bullet(theme, 'It keeps anything it already downloaded. Nothing can unsend that.'),
      bullet(
        theme,
        'It can still fetch the version it was granted, by supplying that ACT timestamp — until the content is written again under the new history.',
      ),
      bullet(theme, 'Re-seal the payload to close the live bytes to it: that is what makes the 404 real.'),
    ]);
    out.line();
  } else {
    out.line(
      `  ${theme.dim('The grantee can now resolve the name, fetch the ciphertext and decrypt it on their own node.')}`,
    );
    out.line(
      `  ${theme.dim('Swarm has no grantee notification of its own — ENS is the discovery channel.')}`,
    );
    out.line();
  }

  return 0;
}

async function nodeAnswers(url: string): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_500);
  try {
    const health = await fetch(new URL('/health', url), { signal: controller.signal });
    if (!health.ok) return { ok: false, detail: `GET /health answered HTTP ${health.status}` };

    const gateway = await fetch(new URL('/gateway', url), { signal: controller.signal }).catch(() => null);
    if (gateway?.ok === true) {
      const body = await gateway.text().catch(() => '');
      if (body.includes('"gateway":true')) {
        return { ok: false, detail: 'that endpoint identifies itself as a gateway, not a node' };
      }
    }
    return { ok: true, detail: 'answered' };
  } catch (cause) {
    return { ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    clearTimeout(timer);
  }
}

/** The refusal. Says what is missing, why it matters, and how to fix it — then exits non-zero. */
function refuse(out: Output, action: string, beeUrl: string, detail: string): number {
  const theme = out.theme;

  if (out.json) {
    out.emit({
      command: action,
      ok: false,
      reason: 'no-bee-node',
      beeUrl,
      detail,
      requirement: 'POST /grantee, exposed only by a Bee node whose ACT publisher key we hold',
    });
    return 1;
  }

  out.lines(section(theme, 'refused'));
  out.line(`  ${theme.bad(theme.glyphs.fail)} No Bee node at ${theme.bold(beeUrl)} — ${detail}`);
  out.line();
  out.lines([
    bullet(theme, `${theme.bold('What is missing:')} a running Bee node that exposes POST /grantee.`),
    bullet(
      theme,
      `${theme.bold('Why the gateway will not do:')} https://api.gateway.ethswarm.org answers POST /grantee with 404, and it holds its own publisher key rather than ours. A grant there would be neither applied nor ours to apply.`,
    ),
    bullet(
      theme,
      `${theme.bold('What it costs you:')} the reference can still be issued, sealed and verified. It cannot be granted to a named reader, and it cannot be revoked.`,
    ),
  ]);
  out.line();
  out.line(`  ${theme.dim('Start a node in light mode and point the CLI at it:')}`);
  out.line(`    ${theme.dim('bee start --full-node=false')}`);
  out.line(`    ${theme.dim(`export ZEGEL_BEE_URL=${beeUrl}`)}`);
  out.line(`    ${theme.dim('zegel doctor')}`);
  out.line();
  out.line(`  ${theme.dim('Nothing was changed. No grant was recorded.')}`);
  out.line();

  return 1;
}
