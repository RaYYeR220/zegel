/**
 * The exposure dossier.
 *
 * This screen is the product's argument, so it has one job: be uncomfortable and
 * be strictly true. Every sentence below is either a number pulled from a live
 * upstream response or arithmetic over those numbers, and where an inference is
 * made — the timezone is the only one — the assumption behind it is printed next
 * to the conclusion rather than left implied.
 *
 * Nothing here is speculative and nothing is padded. If a section has no data it
 * says so and moves on.
 */

import type { ExposureReport } from '../core/exposure.js';
import {
  count,
  days,
  hourWindow,
  isoDay,
  percent,
  plural,
  score,
  shortAddress,
  usd,
  usdSigned,
  utcOffset,
  wrap,
} from './format.js';
import { bullet, field, hourHistogram, section, table } from './layout.js';
import type { Theme } from './theme.js';

export interface ScanRenderOptions {
  ensName?: string | undefined;
  /** Print the source indices behind each section. */
  explain?: boolean;
  /** Wall-clock seconds the collection took, for the opening line. */
  elapsedSeconds?: number | undefined;
  /** Credits the collection spent, when the client reported them. */
  creditsSpent?: number | undefined;
}

export function renderScan(
  theme: Theme,
  report: ExposureReport,
  options: ScanRenderOptions = {},
): string[] {
  const out: string[] = [];
  const width = Math.max(52, theme.width - 4);
  const m = report.metrics;

  const say = (text: string): void => {
    for (const line of wrap(text, width - 2)) out.push(`  ${line}`);
  };
  const provenance = (key: string, endpoint: string): void => {
    if (options.explain !== true) return;
    const indices = report.provenance[key] ?? [];
    out.push(
      `  ${theme.dim(`${theme.glyphs.arrow} ${endpoint} ${indices.length === 0 ? '(no source)' : `source[${indices.join(',')}]`}`)}`,
    );
  };

  // --- header --------------------------------------------------------------
  out.push('');
  out.push(`  ${theme.bold('EXPOSURE DOSSIER')}`);
  out.push(
    `  ${theme.dim(theme.glyphs.horizontal.repeat(Math.max(16, width - 2)))}`,
  );
  out.push(
    field(
      theme,
      'subject',
      options.ensName === undefined
        ? theme.bold(report.address)
        : `${theme.bold(options.ensName)} ${theme.dim(theme.glyphs.arrow)} ${report.address}`,
    ),
  );
  out.push(field(theme, 'chains', report.chains.join(', ')));
  out.push(
    field(theme, 'window', `${isoDay(report.window.from)} to ${isoDay(report.window.to)} (UTC)`),
  );
  if (options.elapsedSeconds !== undefined) {
    const credits =
      options.creditsSpent === undefined ? '' : ` and ${count(options.creditsSpent)} API credits`;
    out.push(
      field(theme, 'cost to produce', `${options.elapsedSeconds.toFixed(1)} s${credits}, no key, no signup`),
    );
  }
  out.push('');
  say(
    theme.dim(
      'Everything below came from one commercial data vendor over public HTTP. No permission was asked for and none was needed. This is the record a counterparty, a landlord, a chain-analytics firm or anyone with your address can buy today.',
    ),
  );

  // --- the money -----------------------------------------------------------
  out.push(...section(theme, 'the money'));
  if (m.closedCycles.length === 0) {
    say(theme.dim('No completed buy-and-sell cycles inside this window. Nothing to read here.'));
  } else {
    const pnl = m.realizedPnlUsd;
    out.push(
      field(
        theme,
        'realized profit/loss',
        `${pnl >= 0 ? theme.good(usdSigned(pnl)) : theme.bad(usdSigned(pnl))} ${theme.dim('over closed trades in this window')}`,
      ),
    );
    out.push(
      field(theme, 'completed trades', `${count(m.closedCycles.length)} ${plural(m.closedCycles.length, 'cycle')}`),
    );
    if (m.winRate !== null) {
      const wins = Math.round(m.winRate * m.closedCycles.length);
      out.push(
        field(
          theme,
          'win rate',
          `${percent(m.winRate)} ${theme.dim(`(${wins} of ${m.closedCycles.length} made money)`)}`,
        ),
      );
    }
    if (m.maxDrawdownUsd !== null) {
      out.push(
        field(theme, 'deepest drawdown', `${usd(m.maxDrawdownUsd)} ${theme.dim('below its own best point')}`),
      );
    }
    if (m.medianHoldingDays !== null) {
      out.push(field(theme, 'typical holding period', days(m.medianHoldingDays)));
    }
    out.push(field(theme, 'gross traded volume', usd(m.grossVolumeUsd)));
    if (m.concentration.topAssetShare !== null) {
      out.push(
        field(
          theme,
          'largest single asset',
          `${m.concentration.topAssetSymbol ?? 'unknown'} at ${percent(m.concentration.topAssetShare)} of volume`,
        ),
      );
    }
    provenance('assets', 'GET /2/wallet/positions-history');

    if (report.worstAssets.length > 0) {
      out.push('');
      out.push(`  ${theme.dim('Worst completed positions, by realized loss:')}`);
      out.push(
        ...table(
          theme,
          [
            { header: 'asset', max: 14 },
            { header: 'chain' },
            { header: 'realized', align: 'right' },
            { header: 'volume', align: 'right' },
            { header: 'cycles', align: 'right' },
          ],
          report.worstAssets.map((a) => [
            a.symbol,
            a.chain ?? 'unknown',
            theme.bad(usdSigned(a.realizedPnlUsd)),
            usd(a.volumeUsd),
            String(a.cycles),
          ]),
        ).map((row) => `  ${row}`),
      );
    }
    if (report.bestAssets.length > 0) {
      out.push('');
      out.push(`  ${theme.dim('Best completed positions, by realized gain:')}`);
      out.push(
        ...table(
          theme,
          [
            { header: 'asset', max: 14 },
            { header: 'chain' },
            { header: 'realized', align: 'right' },
            { header: 'volume', align: 'right' },
            { header: 'cycles', align: 'right' },
          ],
          report.bestAssets.map((a) => [
            a.symbol,
            a.chain ?? 'unknown',
            theme.good(usdSigned(a.realizedPnlUsd)),
            usd(a.volumeUsd),
            String(a.cycles),
          ]),
        ).map((row) => `  ${row}`),
      );
    }
  }

  // --- first funding -------------------------------------------------------
  out.push(...section(theme, 'who funded this wallet first'));
  if (report.funding === null) {
    say(theme.dim('The first inbound transfer could not be identified from the collected sources.'));
  } else {
    const f = report.funding;
    const named = f.entityName ?? f.tag;
    out.push(
      field(
        theme,
        'first money in',
        `${isoDay(f.dateIso)} ${theme.dim(`(${days(f.ageDays)} ago)`)}`,
      ),
    );
    out.push(
      field(
        theme,
        'from',
        named === null
          ? shortAddress(f.from, 10, 8)
          : `${theme.bold(named)} ${theme.dim(shortAddress(f.from, 10, 8))}`,
      ),
    );
    if (f.entityType !== null) out.push(field(theme, 'that party is', f.entityType));
    if (f.entityLabels.length > 0) out.push(field(theme, 'labelled', f.entityLabels.join(', ')));
    if (f.chain !== null) out.push(field(theme, 'on', f.chain));
    if (f.txHash !== null) out.push(field(theme, 'transaction', shortAddress(f.txHash, 12, 8)));
    out.push('');
    say(
      named === null
        ? theme.dim(
            'The first funder is not a tagged entity, but the address and the transaction are public and permanent. Whoever it is can be pursued from here.',
          )
        : theme.dim(
            `The very first transfer into this wallet came from a party the vendor has already put a name to. That link is permanent, and it is the single hardest thing about a wallet to disown.`,
          ),
    );
    provenance('funding', 'GET /2/wallet/funding');
  }

  // --- clock ---------------------------------------------------------------
  out.push(...section(theme, 'when it trades, and therefore where it lives'));
  if (report.clock === null) {
    say(theme.dim('No timestamped swaps were collected, so no working-hours pattern can be read.'));
  } else {
    const c = report.clock;
    out.push(
      field(
        theme,
        'busiest hours',
        `${c.busiestHours.map((h) => `${String(h).padStart(2, '0')}:00`).join(', ')} UTC`,
      ),
    );
    out.push(
      field(
        theme,
        'quietest stretch',
        hourWindow(c.quietStartUtc, c.quietStartUtc + c.quietHours),
      ),
    );
    out.push(
      field(
        theme,
        'implied timezone',
        `${theme.bold(utcOffset(c.impliedOffsetHours))} ${theme.dim(`(${c.confidence} signal, ${c.samples} timestamped ${plural(c.samples, 'swap')})`)}`,
      ),
    );
    out.push(
      field(theme, 'activity concentration', `${percent(c.concentration)} inside an 8-hour band`),
    );
    out.push('');
    out.push(...hourHistogram(theme, c.histogram, Math.min(36, width - 20)));
    out.push('');
    say(
      theme.dim(
        `The inference is one assumption, stated so you can reject it: the quietest eight hours of the day are a night, and a night starts at local midnight. On that assumption the operator's clock sits near ${utcOffset(c.impliedOffsetHours)}. The histogram is raw and lets you check the reasoning.`,
      ),
    );
    if (c.confidence === 'weak') {
      say(
        theme.warn(
          'Confidence is weak here: too few swaps, or activity spread too evenly across the day. Do not read a location into this one.',
        ),
      );
    }
    provenance('clock', 'GET /2/wallet/trades');
  }

  // --- venues --------------------------------------------------------------
  out.push(...section(theme, 'where it trades'));
  if (report.venues.length === 0) {
    say(theme.dim('No swap-execution contracts were seen in the collected trades.'));
  } else {
    out.push(
      ...table(
        theme,
        [
          { header: 'contract that executed the swap', max: 36 },
          { header: 'address' },
          { header: 'trades', align: 'right' },
          { header: 'share', align: 'right' },
        ],
        report.venues
          .slice(0, 8)
          .map((v) => [
            v.label ?? theme.dim('unrecognised contract'),
            shortAddress(v.address, 10, 6),
            String(v.trades),
            percent(v.share, 0),
          ]),
      ).map((row) => `  ${row}`),
    );
    provenance('venues', 'GET /2/wallet/trades');
  }

  // --- risk quality --------------------------------------------------------
  out.push(...section(theme, 'the quality of what it touched'));
  const sec = m.security;
  if (sec.scored === 0) {
    say(
      theme.dim(
        'None of the traded assets carried a security score, so nothing can be said about the risk taken.',
      ),
    );
  } else {
    out.push(
      field(
        theme,
        'assets scored',
        `${count(sec.scored)} of ${count(sec.tradedAssets)} traded${sec.unscored > 0 ? theme.dim(` (${sec.unscored} unscored)`) : ''}`,
      ),
    );
    out.push(
      field(
        theme,
        'scored below 60/100',
        sec.riskyShare === null
          ? 'unavailable'
          : `${theme.bold(count(sec.risky))} ${theme.dim(`(${percent(sec.riskyShare)} of scored assets)`)}`,
      ),
    );
    const killed = report.riskiest.filter((r) => r.killed);
    if (killed.length > 0) {
      out.push(field(theme, 'hard-killed outright', `${count(killed.length)} ${plural(killed.length, 'asset')}`));
    }
    out.push('');
    out.push(
      ...table(
        theme,
        [
          { header: 'asset', max: 14 },
          { header: 'chain' },
          { header: 'safety score', align: 'right' },
          { header: 'why', max: 34 },
        ],
        report.riskiest
          .slice(0, 8)
          .map((r) => [
            r.symbol,
            r.chain ?? 'unknown',
            r.score < 60 ? theme.bad(score(r.score)) : theme.good(score(r.score)),
            r.killed ? theme.bad(r.killReason ?? 'hard kill') : theme.dim('scored, not killed'),
          ]),
      ).map((row) => `  ${row}`),
    );
    out.push('');
    say(
      theme.dim(
        "Scores are Mobula's 14-point safety check — hidden minting rights, insider bundling, faked volume, sell taxes, liquidity locks. They are reported verbatim: even large, well-known tokens are sometimes hard-killed by a supply-concentration rule, and second-guessing the vendor would make the number unverifiable.",
      ),
    );
    provenance('risk', 'GET /2/token/security');
  }

  // --- costs ---------------------------------------------------------------
  out.push(...section(theme, 'what trading cost it'));
  out.push(field(theme, 'fees on closed cycles', usd(m.totalFeesUsd)));
  if (m.tradingCostRatio !== null) {
    out.push(field(theme, 'as a share of volume', percent(m.tradingCostRatio, 2)));
  }
  if (m.mev.sampledTrades > 0) {
    out.push(
      field(
        theme,
        'taken by front-running bots',
        `${usd(m.mev.mevFeesUsd)} ${theme.dim(`of ${usd(m.mev.totalFeesUsd)} sampled across ${count(m.mev.sampledTrades)} swaps`)}`,
      ),
    );
    if (m.mev.share !== null) {
      out.push(field(theme, 'MEV share of costs', percent(m.mev.share, 2)));
    }
  } else {
    out.push(field(theme, 'fee decomposition', theme.dim('no swaps inside the window carried fee detail')));
  }
  provenance('fees', 'GET /2/wallet/trades');

  // --- holdings ------------------------------------------------------------
  if (report.holdings.length > 0) {
    out.push(...section(theme, 'what it holds right now'));
    out.push(field(theme, 'visible position value', usd(report.holdingsValueUsd)));
    out.push('');
    out.push(
      ...table(
        theme,
        [
          { header: 'asset', max: 14 },
          { header: 'chain' },
          { header: 'value', align: 'right' },
          { header: 'unrealized', align: 'right' },
          { header: 'venue', max: 14 },
        ],
        report.holdings.map((h) => [
          h.symbol,
          h.chain ?? 'unknown',
          usd(h.valueUsd),
          h.unrealizedPnlUsd >= 0
            ? theme.good(usdSigned(h.unrealizedPnlUsd))
            : theme.bad(usdSigned(h.unrealizedPnlUsd)),
          h.exchange ?? theme.dim('—'),
        ]),
      ).map((row) => `  ${row}`),
    );
    provenance('holdings', 'GET /2/wallet/positions');
  }

  // --- linked addresses and labels -----------------------------------------
  if (report.linkedAddresses.length > 0) {
    out.push(...section(theme, 'other addresses in the same transactions'));
    for (const address of report.linkedAddresses.slice(0, 10)) {
      out.push(bullet(theme, shortAddress(address, 12, 8)));
    }
    out.push('');
    say(
      theme.dim(
        'These appeared as the sender or the recipient of a swap this wallet was part of. They are a starting point for clustering, which is exactly how deanonymisation begins.',
      ),
    );
  }

  if (report.labels.length > 0) {
    out.push(...section(theme, 'labels the vendor already applies'));
    for (const label of report.labels) out.push(bullet(theme, label));
    provenance('labels', 'GET /2/wallet/labels');
  }

  // --- gaps ----------------------------------------------------------------
  if (report.unavailable.length > 0) {
    out.push(...section(theme, 'what could not be collected'));
    out.push(
      ...table(
        theme,
        [
          { header: 'endpoint', max: 32 },
          { header: 'status' },
          { header: 'reason', max: 40 },
        ],
        report.unavailable.map((u) => [
          u.endpoint,
          u.status === null ? theme.dim('no response') : theme.warn(String(u.status)),
          theme.dim(u.reason.slice(0, 80)),
        ]),
      ).map((row) => `  ${row}`),
    );
    out.push('');
    say(
      theme.dim(
        'These are recorded as unavailable rather than filled in. Nothing above depends on them.',
      ),
    );
  }

  // --- the argument --------------------------------------------------------
  out.push(...section(theme, 'the point'));
  say(
    'None of this needed your consent, your signature or your key. It is the default state of a public address, and it does not expire.',
  );
  out.push('');
  say(
    `Zegel's answer is not to hide the wallet from the chain — that is not possible. It is to stop handing the whole record to a counterparty who only needed one sentence out of it. ${theme.bold('zegel issue')} turns this dossier into a sealed set of derived claims that one named person can read, for a limited time, revocably, under an ENS name that never carries the address.`,
  );
  out.push('');

  return out;
}
