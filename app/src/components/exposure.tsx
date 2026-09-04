'use client';

import { useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { Field, FieldGrid, Footrule, Notice, SectionHead } from '~/components/document';
import { useCreditMeter } from '~/components/health';
import { WORKED_EXAMPLE_NAME } from '~/lib/config';
import { count, days, ratio, shortHex, stampDate, usd, utcOffset } from '~/lib/format';
import { ProgressLog, type LogLine } from '~/components/progress';
import { readNdjson } from '~/lib/ndjson';
import type { CollectProgressEvent, ExposureResult } from '~/lib/types';

/**
 * Page 03 — the page that already exists.
 *
 * Nobody issued it and nobody can withdraw it. Every figure below came out of one
 * vendor's public API with no key and no consent from the wallet's owner, which
 * is the entire argument for the rest of the booklet.
 */
export function Exposure(): ReactNode {
  const [input, setInput] = useState(WORKED_EXAMPLE_NAME);
  const [result, setResult] = useState<ExposureResult | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);
  const { setMeter } = useCreditMeter();
  const abort = useRef<AbortController | null>(null);

  const scan = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;

      setRunning(true);
      setError(null);
      setResult(null);
      setLog([]);
      setProgress(null);
      setMeter(null);

      try {
        const response = await fetch('/api/exposure', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input }),
          signal: controller.signal,
        });

        if (!response.ok && response.headers.get('content-type')?.includes('json') === true) {
          const body = (await response.json()) as { error?: string };
          setError({ message: body.error ?? `HTTP ${response.status}`, hint: null });
          return;
        }

        await readNdjson(response, (event_) => {
          switch (event_['type']) {
            case 'subject': {
              const subject = event_['subject'] as ExposureResult['subject'];
              setLog((lines) => [
                ...lines,
                {
                  text:
                    subject.ensName === null
                      ? `subject ${subject.address}`
                      : `${subject.ensName} resolves to ${subject.address}`,
                  bad: false,
                },
              ]);
              break;
            }
            case 'source':
              setLog((lines) => [
                ...lines,
                {
                  text: `collecting from ${String(event_['host'])}${event_['keyed'] === true ? ' with a key' : ' — no key, no signup'}`,
                  bad: false,
                },
              ]);
              break;
            case 'progress': {
              const p = event_ as unknown as CollectProgressEvent;
              setProgress({ done: p.done, total: p.total });
              setLog((lines) => [
                ...lines,
                {
                  text: `[${p.done}/${p.total}] ${p.endpoint} ${p.status}${p.httpStatus === null ? '' : ` ${p.httpStatus}`}`,
                  bad: p.status === 'unavailable',
                },
              ]);
              break;
            }
            case 'credits':
              setMeter({
                spent: Number(event_['spent'] ?? 0),
                latest: (event_['snapshot'] ?? null) as ExposureResult['credits']['latest'],
                host: '',
                keyed: false,
              });
              break;
            case 'report':
              setResult(event_ as unknown as ExposureResult);
              setMeter((event_ as unknown as ExposureResult).credits);
              break;
            case 'error':
              setError({
                message: String(event_['message']),
                hint: event_['hint'] === null || event_['hint'] === undefined ? null : String(event_['hint']),
              });
              break;
            default:
              break;
          }
        });
      } catch (cause) {
        if ((cause as Error).name !== 'AbortError') {
          setError({ message: cause instanceof Error ? cause.message : String(cause), hint: null });
        }
      } finally {
        setRunning(false);
      }
    },
    [input, setMeter],
  );

  return (
    <section>
      <form className="act" onSubmit={scan} style={{ marginTop: 18 }}>
        <label htmlFor="subject" className="flab" style={{ marginBottom: 0 }}>
          Adres of naam <span className="en">/ Address or ENS name</span>
        </label>
        <input
          id="subject"
          className="textinput"
          style={{ maxWidth: 320 }}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
          }}
          placeholder="vitalik.eth"
          spellCheck={false}
          autoComplete="off"
        />
        <button className="btn" type="submit" disabled={running}>
          {running ? 'uitlezen…' : 'Uitlezen / read off'}
        </button>
        <span className="hint">
          No wallet, no key, no account. This is the dossier anyone can already buy, pulled live from Mobula.
        </span>
      </form>

      <ProgressLog lines={log} running={running} progress={progress} />

      {error !== null && (
        <Notice tone="warn" title="Niets uitgelezen / nothing read">
          {error.message}
          {error.hint !== null && <div style={{ marginTop: 4, opacity: 0.75 }}>{error.hint}</div>}
        </Notice>
      )}

      {result === null && !running && error === null && <Preamble />}

      {result !== null && <Dossier result={result} />}
    </section>
  );
}

function Preamble(): ReactNode {
  return (
    <>
      <div className="identblock">
        <div>
          <div className="window">
            <div className="windowinner hatched">
              <div className="windowmark">
                Nog niets
                <br />
                uitgelezen
              </div>
            </div>
          </div>
          <div className="windowcap">
            Openbaar dossier / Public record
            <b>not yet read</b>
            press read off
          </div>
        </div>
        <div className="windowbody">
          <p className="lede">
            Dit is de bladzijde die al bestaat. Niemand heeft hem afgegeven en niemand kan hem intrekken.
          </p>
          <p>
            An address is not a number, it is a life. Whoever knows it reads along without asking: what was
            earned, what was lost, who was traded with, who sent the first money, and at which hours of the day
            the work happens. Those hours give away the offset. The offset narrows the map.
          </p>
          <p>The rest of this booklet exists so that this page never has to be handed over again.</p>
        </div>
      </div>
      <Footrule
        nl="Deze bladzijde is niet afgegeven en niet intrekbaar"
        en="This page was never issued and cannot be withdrawn"
      />
    </>
  );
}

// ---------------------------------------------------------------------------

function Dossier({ result }: { result: ExposureResult }): ReactNode {
  const { report, subject } = result;
  const m = report.metrics;

  const scores = m.security.readings.map((reading) => reading.score).sort((a, b) => a - b);
  const medianScore = scores.length === 0 ? null : (scores[Math.floor(scores.length / 2)] as number);
  const flagged = m.security.readings.filter((reading) => reading.killed || reading.score < 60);
  const worst = report.worstAssets[0];
  const best = report.bestAssets[0];
  const windowDays = Math.round(
    (Date.parse(report.window.to) - Date.parse(report.window.from)) / 86_400_000,
  );

  return (
    <>
      <div className="identblock">
        <div>
          <div className="window">
            <div className="windowinner exposed">
              <div className="exposedgrid">
                {exposedRows(result).map((row) => (
                  <span key={`${row[0]}-${row[1]}`}>
                    <b>{row[0]}</b> {row[2] === true ? <span className="hot">{row[1]}</span> : row[1]}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="windowcap">
            Openbaar dossier / Public record
            <b>volledig afgebeeld</b>
            shown in full
          </div>
        </div>

        <div className="windowbody">
          <p className="lede">
            Dit is de bladzijde die al bestaat. Niemand heeft hem afgegeven en niemand kan hem intrekken.
          </p>
          <p>
            Everything on this page came from one vendor, over {windowDays} days, with no key and no consent
            from the address that owns it. It cost {result.credits.spent} credits and about half a minute.
          </p>
          {subject.ensName !== null && (
            <p style={{ opacity: 0.8, fontSize: 11.5 }}>
              {subject.ensName} is a public name; every analytics firm publishes this wallet already, which is
              why it is the worked example here. Nothing below is private data — that is the problem being
              described.
            </p>
          )}

          <FieldGrid>
            {report.funding !== null && (
              <>
                <Field
                  nl="Eerste vastlegging"
                  en="First record"
                  value={stampDate(report.funding.dateIso)}
                />
                <Field
                  nl="Duur"
                  en="Length of record"
                  value={days(report.funding.ageDays)}
                />
                <Field
                  span
                  nl="Eerste storting door"
                  en="First funded by"
                  value={
                    report.funding.entityName ??
                    report.funding.tag ??
                    shortHex(report.funding.from, 12, 8)
                  }
                  note={
                    report.funding.entityName === null && report.funding.tag === null
                      ? `${report.funding.from} — unlabelled by Mobula, so it is reported as an address rather than guessed at.`
                      : `Behind that transfer stands a completed identity check, and it stands there for good.`
                  }
                />
              </>
            )}
            {report.funding === null && (
              <Field
                span
                nl="Eerste storting"
                en="First funding"
                tone="grey"
                value="niet beschikbaar / unavailable"
                note="Mobula returned no first-funding record for this address. Nothing is substituted for it."
              />
            )}
          </FieldGrid>
        </div>
      </div>

      <SectionHead nl="Uitgelezen door derden" en="Read off by third parties" />

      <ul className="plainlist">
        <Row
          label={`Gerealiseerd resultaat over ${windowDays} dagen`}
          sub={`${count(m.closedCycles.length)} closed positions, ${count(
            m.closedCycles.filter((cycle) => cycle.realizedPnlUsd > 0).length,
          )} in profit`}
          value={usd(m.realizedPnlUsd, { sign: true })}
          warn={m.realizedPnlUsd < 0}
        />
        {m.winRate !== null && (
          <Row
            label="Trefkans en houdduur"
            sub="Enough to price someone as a customer — or as a target"
            value={`${ratio(m.winRate, 0)} / ${m.medianHoldingDays === null ? '—' : days(m.medianHoldingDays)}`}
          />
        )}
        {worst !== undefined && (
          <Row
            label="Grootste enkelvoudige verlies"
            sub={`${worst.symbol}, over ${count(worst.cycles)} completed trades. The asset and the amount are on the record.`}
            value={usd(worst.realizedPnlUsd)}
            warn
          />
        )}
        {best !== undefined && (
          <Row
            label="Grootste enkelvoudige winst"
            sub={`${best.symbol} — the good days are as public as the bad ones`}
            value={usd(best.realizedPnlUsd, { sign: true })}
          />
        )}
        <Row
          label="Kosten en onttrekkingen"
          sub={
            m.mev.share === null
              ? `Across ${count(m.mev.sampledTrades)} sampled swaps; Mobula reported no MEV split`
              : `Of which ${usd(m.mev.mevFeesUsd)} was taken out of its own orders by parties that saw them coming`
          }
          value={usd(m.totalFeesUsd)}
        />
        <Row
          label="Tegenpartijen"
          sub={
            report.venues.length === 0
              ? 'No swap venues were reported for this window'
              : `${report.venues
                  .slice(0, 4)
                  .map((venue) => venue.label ?? shortHex(venue.address, 8, 4))
                  .join(', ')}${report.linkedAddresses.length > 0 ? ` and ${count(report.linkedAddresses.length)} addresses with no name` : ''}`
          }
          value={count(report.venues.length + report.linkedAddresses.length)}
        />
        {medianScore !== null && (
          <Row
            label="Kwaliteit van de aangehouden activa"
            sub={`Median over ${count(m.security.scored)} scored assets, on Mobula's 14-point safety check`}
            value={`${medianScore} / 100`}
            warn={medianScore < 60}
          />
        )}
        {m.security.scored > 0 && (
          <Row
            label="Gemarkeerde stukken"
            sub={
              flagged.length === 0
                ? 'Nothing below the floor of 60'
                : flagged
                    .slice(0, 3)
                    .map(
                      (reading) =>
                        `${reading.symbol}: ${reading.killed ? reading.killReason ?? 'hard-killed' : `score ${reading.score}`}`,
                    )
                    .join(' · ')
            }
            value={count(flagged.length)}
            warn={flagged.length > 0}
          />
        )}
        {m.concentration.topAssetShare !== null && (
          <Row
            label="Concentratie"
            sub={`Largest single-asset share of everything traded${
              m.concentration.topAssetSymbol === null ? '' : ` — ${m.concentration.topAssetSymbol}`
            }`}
            value={ratio(m.concentration.topAssetShare)}
            warn={m.concentration.topAssetShare > 0.5}
          />
        )}
        {report.labels.length > 0 && (
          <Row
            label="Etiketten van de aanbieder"
            sub="Mobula's own wallet taxonomy, applied without asking"
            value={report.labels.slice(0, 3).join(', ')}
          />
        )}
      </ul>

      <SectionHead nl="Uren van bedrijvigheid" en="Hours of activity" />

      {report.clock === null ? (
        <Notice tone="dim">
          No trade carried a usable timestamp in this window, so there is no clock to read. Nothing is inferred
          from an empty histogram.
        </Notice>
      ) : (
        <Clock clock={report.clock} />
      )}

      {report.unavailable.length > 0 && (
        <>
          <SectionHead nl="Niet opgehaald" en="Could not be collected" />
          <ul className="plainlist">
            {report.unavailable.map((entry) => (
              <li key={`${entry.endpoint}-${entry.reason}`}>
                <span>
                  {entry.endpoint}
                  <span className="sm">{entry.reason}</span>
                </span>
                <b className="dim">{entry.status === null ? 'no answer' : `HTTP ${entry.status}`}</b>
              </li>
            ))}
          </ul>
          <Notice tone="dim">
            These upstreams failed and are recorded as failed. Nothing on this page was computed from a default
            in their place.
          </Notice>
        </>
      )}

      <Footrule
        nl="Deze bladzijde is niet afgegeven en niet intrekbaar"
        en="This page was never issued and cannot be withdrawn"
      />
    </>
  );
}

function Row({
  label,
  sub,
  value,
  warn,
}: {
  label: string;
  sub: string;
  value: string;
  warn?: boolean;
}): ReactNode {
  return (
    <li>
      <span>
        {label}
        <span className="sm">{sub}</span>
      </span>
      <b className={warn === true ? 'warn' : ''}>{value}</b>
    </li>
  );
}

function Clock({ clock }: { clock: NonNullable<ExposureResult['report']['clock']> }): ReactNode {
  const peak = Math.max(...clock.histogram, 1);
  const quietEnd = (clock.quietStartUtc + clock.quietHours) % 24;
  const busyHours = new Set(clock.busiestHours);

  return (
    <div className="hourband">
      <div className="hourbars" aria-hidden="true">
        {clock.histogram.map((value, hour) => (
          <i
            key={hour}
            className={busyHours.has(hour) ? 'day' : ''}
            style={{ height: `${Math.max(3, Math.round((value / peak) * 100))}%` }}
          />
        ))}
      </div>
      <div className="hourticks" aria-hidden="true">
        {clock.histogram.map((_, hour) => (
          <span key={hour}>{String(hour).padStart(2, '0')}</span>
        ))}
      </div>
      <p className="visually-hidden" style={{ position: 'absolute', left: -9999 }}>
        Activity by UTC hour: {clock.histogram.map((value, hour) => `${hour}h ${value}`).join(', ')}.
      </p>
      <div className="hourconc">
        <div className="pct">{ratio(clock.concentration, 0)}</div>
        <div className="txt">
          of all activity falls inside its busiest eight hours, and almost nothing happens between{' '}
          {String(clock.quietStartUtc).padStart(2, '0')}:00 and {String(quietEnd).padStart(2, '0')}:00 UTC.
          Read that quiet stretch as a night and the offset is{' '}
          <b>{utcOffset(clock.impliedOffsetHours)}</b>. Nobody declared that. The clock did it.
          <span style={{ display: 'block', marginTop: 6, opacity: 0.7, fontSize: 11.5 }}>
            {clock.samples} timestamped trades · confidence {clock.confidence}
            {clock.confidence === 'weak'
              ? ' — too few or too scattered to be worth anything, and it says so rather than pretending'
              : ''}
          </span>
        </div>
      </div>
    </div>
  );
}

/** The window that a normal document reserves for a face, filled the way an analytics vendor fills it. */
function exposedRows(result: ExposureResult): [string, string, boolean?][] {
  const { report } = result;
  const m = report.metrics;
  const rows: [string, string, boolean?][] = [];

  if (report.funding !== null) {
    rows.push(['FIRST TX', report.funding.dateIso.slice(0, 10)]);
    rows.push(['SOURCE', (report.funding.entityName ?? report.funding.from).slice(0, 22).toUpperCase()]);
    rows.push(['AGE', days(report.funding.ageDays).toUpperCase()]);
  }
  rows.push(['REALIZED', usd(m.realizedPnlUsd, { sign: true })]);
  rows.push(['POSITIONS', `${m.closedCycles.length} CLOSED`]);
  if (m.winRate !== null) rows.push(['WINS', ratio(m.winRate, 0)]);
  if (m.medianHoldingDays !== null) rows.push(['MED HOLD', days(m.medianHoldingDays).toUpperCase()]);
  if (m.maxDrawdownUsd !== null) rows.push(['DRAWDOWN', usd(m.maxDrawdownUsd)]);
  rows.push(['FEES', usd(m.totalFeesUsd)]);
  if (m.mev.share !== null) rows.push(['MEV TAKEN', usd(m.mev.mevFeesUsd)]);
  rows.push(['VOLUME', usd(m.grossVolumeUsd)]);
  for (const asset of report.bestAssets.slice(0, 3)) {
    rows.push([asset.symbol.slice(0, 10).toUpperCase(), usd(asset.realizedPnlUsd, { sign: true })]);
  }
  for (const asset of report.worstAssets.slice(0, 2)) {
    rows.push([asset.symbol.slice(0, 10).toUpperCase(), usd(asset.realizedPnlUsd), true]);
  }
  for (const venue of report.venues.slice(0, 3)) {
    rows.push([(venue.label ?? venue.address).slice(0, 12).toUpperCase(), `${venue.trades} TRADES`]);
  }
  rows.push(['PARTIES', `${report.linkedAddresses.length} ADDR`]);
  rows.push(['ASSETS', `${m.security.tradedAssets} TRADED`]);
  if (m.security.scored > 0) rows.push(['SCORED', `${m.security.scored} / ${m.security.tradedAssets}`]);
  for (const reading of report.riskiest.slice(0, 2)) {
    if (reading.killed || reading.score < 60) {
      rows.push(['FLAGGED', `${reading.symbol} ${reading.score}`.slice(0, 22).toUpperCase(), true]);
    }
  }
  if (report.holdings.length > 0) {
    rows.push(['HOLDING NOW', usd(report.holdingsValueUsd)]);
  }
  if (report.clock !== null) {
    rows.push([
      'PEAK HOURS',
      report.clock.busiestHours.map((hour) => `${String(hour).padStart(2, '0')}`).join('/') + ' UTC',
    ]);
    rows.push([
      'QUIET',
      `${String(report.clock.quietStartUtc).padStart(2, '0')}-${String(
        (report.clock.quietStartUtc + report.clock.quietHours) % 24,
      ).padStart(2, '0')} UTC`,
    ]);
    rows.push(['OFFSET', utcOffset(report.clock.impliedOffsetHours), true]);
    rows.push(['CONFIDENCE', report.clock.confidence.toUpperCase()]);
  }
  return rows;
}
