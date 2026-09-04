#!/usr/bin/env node
/**
 * zegel-sas — reproduce every claim this package makes from a terminal.
 *
 *   zegel-sas status                              read-only, no key
 *   zegel-sas issue   --subject … --reference-id … --commitment … --expires-at … --derivation-id …
 *   zegel-sas verify  --subject … --reference-id … [--commitment …]   read-only, no key
 *   zegel-sas revoke  --subject … [--reference-id …]
 *   zegel-sas close   --subject … [--force]
 *
 * `status` and `verify` never touch a keypair, which is the point: a verifier runs
 * the same binary against a public RPC and reaches the same verdict we do.
 */

import { CLUSTERS, type ClusterName, explorerAccountUrl } from '../constants.ts';
import { createIssuer } from '../issuer.ts';
import { issue } from '../issue.ts';
import { loadKeypairFile } from '../keypair.ts';
import { close, revoke } from '../revoke.ts';
import { issuerStatus } from '../status.ts';
import type { ReferenceStatus } from '../types.ts';
import { verify } from '../verify.ts';

const USAGE = `zegel-sas — Solana Attestation Service anchor for Zegel references

Commands
  status                     issuer credential / schema / mint state (no key needed)
  issue                      create a tokenized reference attestation
  verify                     check a reference against the chain (no key needed)
  revoke                     withdraw a live reference (issuer only)
  close                      reclaim rent from a lapsed reference (issuer only)

Common flags
  --rpc <url>                RPC endpoint          [env ZEGEL_SOLANA_RPC]
  --cluster <name>           devnet | mainnet-beta (default devnet)
  --keypair <path>           issuer keypair JSON   [env ZEGEL_SOLANA_KEYPAIR]
  --issuer <pubkey>          issuer authority for read-only commands
                                                   [env ZEGEL_SOLANA_ISSUER]
  --json                     machine-readable output
  --priority-fee <n>         micro-lamports per compute unit on the write commands
                             (default 0)

issue / verify / revoke / close flags
  --subject <pubkey>         the subject's Solana pubkey (the attestation nonce)
  --reference-id <hex32>     the Zegel reference id
  --commitment <hex32>       sha256 over the canonical ClaimSet
  --expires-at <iso|unix>    expiry (issue)
  --derivation-id <hex32>    derivation pin (issue)
  --tiers <n>                sealed disclosure tiers, default 2 (issue)
  --no-history               skip the revoked-vs-never-existed lookup (verify)
  --force                    close a reference that has not expired (close)

Exit codes
  0 success, or verify status \`valid\`
  1 usage or runtime error
  2 verify reached a non-valid status
`;

type Flags = Record<string, string | boolean>;

function parseArgs(argv: readonly string[]): { command: string | undefined; flags: Flags } {
  const [command, ...rest] = argv;
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return { command, flags };
}

function str(flags: Flags, name: string, envVar?: string): string | undefined {
  const value = flags[name];
  if (typeof value === 'string') return value;
  // A flag written without its value must not fall through to "not supplied".
  // `verify --commitment` with a missing argument would otherwise skip the
  // commitment check entirely and answer `valid`.
  if (value === true) throw new Error(`--${name} needs a value`);
  return envVar ? process.env[envVar] : undefined;
}

function required(flags: Flags, name: string, envVar?: string): string {
  const value = str(flags, name, envVar);
  if (!value) throw new Error(`missing --${name}${envVar ? ` (or ${envVar})` : ''}`);
  return value;
}

function resolveCluster(flags: Flags): ClusterName {
  const raw = str(flags, 'cluster') ?? 'devnet';
  if (raw in CLUSTERS) return raw as ClusterName;
  throw new Error(`unknown cluster ${raw}; expected one of ${Object.keys(CLUSTERS).join(', ')}`);
}

function resolveRpcUrl(flags: Flags, cluster: ClusterName): string {
  return str(flags, 'rpc', 'ZEGEL_SOLANA_RPC') ?? CLUSTERS[cluster].rpcUrl;
}

const NON_VALID_EXIT: ReadonlySet<ReferenceStatus> = new Set([
  'expired',
  'revoked',
  'not-found',
  'commitment-mismatch',
  'reference-mismatch',
  'schema-paused',
]);

function emit(json: boolean, value: unknown, lines: () => string[]): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, bigintSafe, 2)}\n`);
  } else {
    process.stdout.write(`${lines().join('\n')}\n`);
  }
}

function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const json = flags['json'] === true;
  const cluster = resolveCluster(flags);
  const rpcUrl = resolveRpcUrl(flags, cluster);

  switch (command) {
    case 'status': {
      const issuerAuthority = await resolveIssuerAuthority(flags);
      const status = await issuerStatus({ rpcUrl, issuerAuthority });
      emit(json, { cluster, rpcUrl, ...status }, () => [
        `cluster            ${cluster}`,
        `rpc                ${rpcUrl}`,
        `authority          ${status.addresses.authority}  (${status.authorityBalanceSol} SOL)`,
        `credential "${status.names.credential}"  ${status.addresses.credential}  ${mark(status.credentialLive)}`,
        `schema "${status.names.schema}" v${status.names.version}  ${status.addresses.schema}  ${mark(status.schemaLive)}`,
        `schema mint        ${status.addresses.schemaMint}  ${mark(status.schemaMintLive)}`,
        `schema paused      ${status.schemaPaused}`,
        `schema fields      ${status.schemaFields.join(', ')}${status.schemaLive ? '' : '  (expected; nothing on chain yet)'}`,
        `layout as expected ${status.schemaLive ? status.schemaMatchesExpected : 'n/a'}`,
        `authorized signers ${status.authorizedSigners.join(', ') || '(none)'}`,
        `explorer           ${explorerAccountUrl(status.addresses.credential, cluster)}`,
      ]);
      return 0;
    }

    case 'issue': {
      const issuer = await openIssuer(flags, rpcUrl);
      const result = await issue({
        issuer,
        subject: required(flags, 'subject'),
        referenceId: required(flags, 'reference-id'),
        commitment: required(flags, 'commitment'),
        expiresAt: required(flags, 'expires-at'),
        derivationId: required(flags, 'derivation-id'),
        ...(typeof flags['tiers'] === 'string' ? { tierCount: Number(flags['tiers']) } : {}),
      });
      emit(json, { cluster, setup: issuer.setup, ...result }, () => [
        `issued             ${result.data.referenceId}`,
        `subject            ${result.subject}`,
        `attestation        ${result.attestation}`,
        `attestation mint   ${result.attestationMint}`,
        `subject token acct ${result.recipientTokenAccount}`,
        `commitment         ${result.data.commitment}`,
        `expires            ${new Date(Number(result.data.expiresAt) * 1000).toISOString()}`,
        `signature          ${result.signature}`,
        `explorer           ${explorerAccountUrl(result.signature, cluster)}`,
      ]);
      return 0;
    }

    case 'verify': {
      const issuerAuthority = await resolveIssuerAuthority(flags);
      const result = await verify({
        rpcUrl,
        issuerAuthority,
        subject: required(flags, 'subject'),
        referenceId: required(flags, 'reference-id'),
        ...(str(flags, 'commitment') ? { commitment: str(flags, 'commitment') as string } : {}),
        checkRevocationHistory: flags['no-history'] !== true,
      });
      emit(json, { cluster, ...result }, () => [
        `status             ${result.status.toUpperCase()}`,
        `                   ${result.detail}`,
        `subject            ${result.subject}`,
        `attestation        ${result.attestation}`,
        `credential         ${result.credential}`,
        `schema             ${result.schema}  (paused: ${result.schemaPaused})`,
        ...(result.onchain
          ? [
              `anchored ref       ${result.onchain.referenceId}`,
              `anchored commit    ${result.onchain.commitment}`,
              `derivation id      ${result.onchain.derivationId}`,
              `tiers              ${result.onchain.tierCount}`,
            ]
          : []),
        ...(result.revocation
          ? [
              `revoked by         ${result.revocation.instruction}`,
              `revocation tx      ${result.revocation.signature}`,
              `explorer           ${explorerAccountUrl(result.revocation.signature, cluster)}`,
            ]
          : [`explorer           ${explorerAccountUrl(result.attestation, cluster)}`]),
      ]);
      return NON_VALID_EXIT.has(result.status) ? 2 : 0;
    }

    case 'revoke':
    case 'close': {
      const issuer = await openIssuer(flags, rpcUrl);
      const subject = required(flags, 'subject');
      const referenceId = str(flags, 'reference-id');
      const result =
        command === 'revoke'
          ? await revoke({ issuer, subject, ...(referenceId ? { referenceId } : {}) })
          : await close({
              issuer,
              subject,
              ...(referenceId ? { referenceId } : {}),
              force: flags['force'] === true,
            });
      emit(json, { cluster, command, ...result }, () => [
        `${command === 'revoke' ? 'revoked' : 'closed'}            ${result.referenceId}`,
        `subject            ${result.subject}`,
        `attestation        ${result.attestation}  (account now closed)`,
        `tokenized          ${result.tokenized}`,
        `signature          ${result.signature}`,
        `explorer           ${explorerAccountUrl(result.signature, cluster)}`,
      ]);
      return 0;
    }

    default:
      process.stdout.write(USAGE);
      return command === undefined || command === 'help' || command === '--help' ? 0 : 1;
  }
}

function mark(live: boolean): string {
  return live ? 'live' : 'absent';
}

async function openIssuer(flags: Flags, rpcUrl: string) {
  const keypairPath = required(flags, 'keypair', 'ZEGEL_SOLANA_KEYPAIR');
  const keypair = await loadKeypairFile(keypairPath);
  const priorityFee = str(flags, 'priority-fee');
  return createIssuer({
    rpcUrl,
    keypair,
    // Zero unless asked for: a mainnet cost should be the operator's explicit choice,
    // not something the tool quietly spends on their behalf.
    ...(priorityFee ? { sendOptions: { computeUnitPriceMicroLamports: Number(priorityFee) } } : {}),
  });
}

/** Read-only commands take the issuer pubkey directly, or derive it from a keypair if one is around. */
async function resolveIssuerAuthority(flags: Flags): Promise<string> {
  const explicit = str(flags, 'issuer', 'ZEGEL_SOLANA_ISSUER');
  if (explicit) return explicit;
  const keypairPath = str(flags, 'keypair', 'ZEGEL_SOLANA_KEYPAIR');
  if (!keypairPath) throw new Error('missing --issuer (or ZEGEL_SOLANA_ISSUER), and no --keypair to derive it from');
  return (await loadKeypairFile(keypairPath)).address;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
