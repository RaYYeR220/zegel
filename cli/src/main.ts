/**
 * The Zegel command line.
 *
 * One shape for every command: they all take `--json`, they all honour
 * `NO_COLOR`, and they all exit with a code that means something. The verdict
 * codes are the interesting part — `zegel verify` distinguishes valid, expired,
 * revoked, tampered and not-granted by exit status, so the demo is scriptable
 * and the distinctions are not merely decorative prose.
 */

import { Command, Option } from 'commander';

import { CliError, createOutput, type Output } from './core/output.js';
import { EXIT_FAILURE } from './core/status.js';

const VERSION = '0.1.0';

interface GlobalFlags {
  json?: boolean;
  color?: boolean;
  ascii?: boolean;
  quiet?: boolean;
}

function makeOutput(command: Command): Output {
  const globals = command.optsWithGlobals<GlobalFlags>();
  return createOutput({
    json: globals.json === true,
    ...(globals.color === false ? { color: false } : {}),
    ...(globals.ascii === true ? { ascii: true } : {}),
    ...(globals.quiet === true ? { quiet: true } : {}),
  });
}

/** Runs a command, prints failures in the CLI's own voice, and never leaks a stack trace. */
async function run(command: Command, work: (out: Output) => Promise<number>): Promise<void> {
  const out = makeOutput(command);
  try {
    const code = await work(out);
    out.flush();
    process.exitCode = code;
  } catch (cause) {
    out.endProgress();
    const theme = out.theme;
    const failure = cause instanceof CliError ? cause : null;
    const message = cause instanceof Error ? cause.message : String(cause);

    process.stderr.write(`\n${theme.bad(`${theme.glyphs.fail} ${message}`)}\n`);
    for (const hint of failure?.hints ?? []) {
      process.stderr.write(`  ${theme.dim(hint)}\n`);
    }
    if (failure === null && process.env['ZEGEL_DEBUG'] !== undefined && cause instanceof Error) {
      process.stderr.write(`${theme.dim(cause.stack ?? '')}\n`);
    } else if (failure === null) {
      process.stderr.write(`  ${theme.dim('Set ZEGEL_DEBUG=1 for the stack trace.')}\n`);
    }
    process.stderr.write('\n');
    process.exitCode = failure?.exitCode ?? EXIT_FAILURE;
  }
}

function integer(name: string) {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new CliError(`${name} must be a non-negative whole number, got "${value}"`);
    }
    return parsed;
  };
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('zegel')
    .description(
      'A private financial reference. Prove you are good with money to one person,\n' +
        'for a limited time, revocably, without revealing the wallet.',
    )
    .version(VERSION, '-v, --version')
    .option('--json', 'machine-readable output on stdout, nothing else')
    .option('--no-color', 'plain text (NO_COLOR is honoured without this)')
    .option('--ascii', 'ASCII-only box drawing for terminals that mangle Unicode')
    .option('-q, --quiet', 'no progress output')
    .showHelpAfterError();

  program
    .command('scan')
    .argument('<address-or-name>', 'an EVM address, a Solana address, or an ENS name')
    .description('the exposure dossier: what anyone can already learn about this wallet')
    .option('--chains <list>', 'comma-separated chain ids (default evm:1,evm:8453,solana)')
    .option('--days <n>', 'window length in days (default 730)', integer('--days'))
    .option('--max-security <n>', 'how many assets to score for risk (10 credits each)', integer('--max-security'))
    .option('--concurrency <n>', 'parallel upstream requests', integer('--concurrency'))
    .option('--history-limit <n>', 'position-history page size', integer('--history-limit'))
    .option('--trades-limit <n>', 'trade page size', integer('--trades-limit'))
    .option('--no-probe-optional', 'skip the Mobula routes known to fail upstream')
    .option('--explain', 'print the upstream endpoint behind each section')
    .option('--rpc <url>', 'mainnet RPC used to resolve an ENS name')
    .option('--out <file>', 'also write the collected evidence bundle here')
    .action(async (target: string, options, command: Command) => {
      await run(command, async (out) => {
        const { scan } = await import('./commands/scan.js');
        return scan(out, target, options);
      });
    });

  program
    .command('issue')
    .argument('[address-or-name]', 'the subject of the reference; omit it when --bundle supplies one')
    .description('derive claims from live data, seal both tiers, print the envelope and its commitment')
    .option('--chains <list>', 'comma-separated chain ids')
    .option('--days <n>', 'window length in days (default 730)', integer('--days'))
    .option('--max-security <n>', 'how many assets to score for risk', integer('--max-security'))
    .option('--concurrency <n>', 'parallel upstream requests', integer('--concurrency'))
    .option('--expires-days <n>', 'how long the reference stays valid (default 30)', integer('--expires-days'))
    .option('--bundle <file>', 'reuse an evidence bundle instead of collecting again')
    .option('--grant <pubkey...>', 'compressed public keys to grant at seal time (needs a Bee node)')
    .option('--no-seal', 'derive and commit only; do not touch Swarm')
    .option('--out <dir>', 'where to write envelope.json and claims.json (default .zegel)')
    .option('--emit-bundle', 'also write the tier-2 bundle, which contains the address')
    .option('--explain', 'print the upstream sources behind each claim')
    .option('--anchor <address>', 'ZegelAnchor address to record as the revocation hint')
    .option('--anchor-chain <id>', 'chain id for the anchor (default 8453)', integer('--anchor-chain'))
    .option('--rpc <url>', 'mainnet RPC used to resolve an ENS name')
    .action(async (target: string | undefined, options, command: Command) => {
      await run(command, async (out) => {
        const { issue } = await import('./commands/issue.js');
        return issue(out, target, options);
      });
    });

  program
    .command('verify')
    .argument('<name-or-envelope>', 'an ENS name, or a path to an envelope.json')
    .description('recompute the commitment and report valid / expired / revoked / tampered / not-granted')
    .option('--claims <file>', 'tier-1 claim set to recompute the commitment from')
    .option('--anchor <address>', 'ZegelAnchor address (default: the deployed contract on Base)')
    .option('--anchor-rpc <url>', 'RPC for the anchor chain (default Base mainnet)')
    .option('--skip-anchor', 'do not read the chain; the verdict will say revocation was not ruled out')
    .option('--rpc <url>', 'mainnet RPC used when the target is an ENS name')
    .addOption(
      new Option('--open <tier>', 'try to open a sealed tier, to see whether you were granted')
        .argParser(integer('--open')),
    )
    .option('--show-claims', 'print the claim set that was verified')
    .option('--explain', 'print the upstream sources behind each claim')
    .action(async (target: string, options, command: Command) => {
      await run(command, async (out) => {
        const { verify } = await import('./commands/verify.js');
        return verify(out, target, options);
      });
    });

  program
    .command('grant')
    .argument('<pubkey...>', 'compressed secp256k1 public keys, 66 hex characters each')
    .description('add readers to a sealed tier (requires a local Bee node)')
    .option('--receipts <file>', 'seal receipt log (default .zegel/receipts.jsonl)')
    .option('--tier <n>', 'which sealed tier to patch (default 2)', integer('--tier'))
    .option('--reference <id>', 'restrict to one reference id')
    .option('--bee-url <url>', 'Bee node API (default http://127.0.0.1:1633)')
    .action(async (pubkeys: string[], options, command: Command) => {
      await run(command, async (out) => {
        const { grantee } = await import('./commands/grantee.js');
        return grantee(out, 'grant', pubkeys, options);
      });
    });

  program
    .command('revoke')
    .argument('<pubkey...>', 'compressed secp256k1 public keys to cut off')
    .description('remove readers from a sealed tier (requires a local Bee node)')
    .option('--receipts <file>', 'seal receipt log (default .zegel/receipts.jsonl)')
    .option('--tier <n>', 'which sealed tier to patch (default 2)', integer('--tier'))
    .option('--reference <id>', 'restrict to one reference id')
    .option('--bee-url <url>', 'Bee node API (default http://127.0.0.1:1633)')
    .action(async (pubkeys: string[], options, command: Command) => {
      await run(command, async (out) => {
        const { grantee } = await import('./commands/grantee.js');
        return grantee(out, 'revoke', pubkeys, options);
      });
    });

  program
    .command('keypair')
    .description('generate a throwaway grantee key, so grant and revoke can be demonstrated')
    .action(async (_options, command: Command) => {
      await run(command, async (out) => {
        const { keypair } = await import('./commands/keypair.js');
        return keypair(out);
      });
    });

  program
    .command('doctor')
    .description('probe every dependency and print what works right now')
    .option('--deep', 'also probe the Mobula routes that are known to fail upstream')
    .option('--timeout <ms>', 'per-probe timeout', integer('--timeout'))
    .action(async (options, command: Command) => {
      await run(command, async (out) => {
        const { doctor } = await import('./commands/doctor.js');
        return doctor(out, options);
      });
    });

  return program;
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  await buildProgram().parseAsync([...argv]);
}
