'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Footrule, Notice, SectionHead, Stamp } from '~/components/document';
import { EXPLORERS, ZEGEL_NAME } from '~/lib/config';
import { shortHex, stampDate, stampDateTime } from '~/lib/format';
import { ladderFromLine2 } from '~/lib/mrz';
import { useReferences } from '~/lib/store';
import type { ReferenceRecord, Verdict, VerifyResult } from '~/lib/types';
import type { ClaimSet } from '@zegel/sdk/types';

type Presented =
  | { id: string; kind: 'record'; label: string; meta: string; record: ReferenceRecord }
  | { id: string; kind: 'forgery'; label: string; meta: string; record: ReferenceRecord }
  | { id: string; kind: 'name'; label: string; meta: string; name: string };

const VERDICTS: Record<Verdict, { nl: string; en: string; tone: 'blue' | 'bad' | 'grey'; sub: string }> = {
  valid: { nl: 'Geldig', en: 'Valid', tone: 'blue', sub: 'Post 04' },
  expired: { nl: 'Verlopen', en: 'Expired', tone: 'grey', sub: 'Geldigheidsdatum gepasseerd' },
  revoked: { nl: 'Ingetrokken', en: 'Revoked', tone: 'bad', sub: 'Vastlegging op Base' },
  tampered: { nl: 'Geweigerd', en: 'Refused', tone: 'bad', sub: 'Opgave overtreft herafleiding' },
  'not-granted': { nl: 'Geen toegang', en: 'Not granted', tone: 'bad', sub: 'Swarm antwoordt 404' },
  'not-found': { nl: 'Geen record', en: 'Not on file', tone: 'bad', sub: 'Niet in het register' },
};

/**
 * Page 09 — the inspection desk.
 *
 * Four outcomes are possible and a fifth does not exist. Watch the last one: a
 * withdrawn document does not produce a refusal, because a refusal is itself a
 * disclosure. It produces *no record*.
 */
export function Verify(): ReactNode {
  const { records, ready } = useReferences();
  const [name, setName] = useState(ZEGEL_NAME);
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);

  const queue = useMemo<Presented[]>(() => {
    const rows: Presented[] = records.map((record) => ({
      id: `record-${record.referenceId}`,
      kind: 'record' as const,
      label: record.ensName ?? shortHex(record.referenceId, 12, 8),
      meta: `${record.tiers.length} sealed tier(s) — issued ${stampDate(record.issuedAt)}`,
      record,
    }));

    const first = records[0];
    if (first !== undefined) {
      rows.push({
        id: `forgery-${first.referenceId}`,
        kind: 'forgery',
        label: 'Aangeboden kopie',
        meta: 'the negative control — one number changed, everything else identical',
        record: first,
      });
    }

    rows.push({
      id: 'by-name',
      kind: 'name',
      label: name === '' ? 'een naam' : name,
      meta: 'resolve an envelope from an ENS name under ENSIP-24',
      name,
    });

    return rows;
  }, [name, records]);

  const inspect = useCallback(async (entry: Presented) => {
    setBusy(true);
    setFailure(null);
    setResult(null);
    try {
      const body =
        entry.kind === 'name'
          ? { name: entry.name }
          : entry.kind === 'record'
            ? { envelope: entry.record.envelope }
            : { envelope: entry.record.envelope, claimSet: forge(entry.record.claimSet), tampered: true };

      const response = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const problem = (await response.json()) as { error?: string };
        setFailure(problem.error ?? `HTTP ${response.status}`);
        return;
      }

      setResult((await response.json()) as VerifyResult);
      if (strip.current !== null) {
        strip.current.classList.remove('scanning');
        void strip.current.offsetWidth;
        strip.current.classList.add('scanning');
      }
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!ready || selected !== null) return;
    const first = queue[0];
    if (first === undefined) return;
    setSelected(first.id);
    void inspect(first);
    // Only the first arrival should trigger this; later selections are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return (
    <section>
      <p className="lede">
        Grenscontrole. Het document wordt aangeboden, de machineleesbare zone wordt gelezen, en de
        controlecijfers worden hier ter plekke opnieuw uitgerekend.
      </p>
      <p className="prose">
        Four outcomes are possible and a fifth does not exist. Watch the last one: a withdrawn document does
        not produce a refusal, because a refusal is itself a disclosure. It produces <em>no record</em>.
      </p>

      <div className="control">
        <div>
          <h2 className="sectionhead" style={{ paddingTop: 12 }}>
            Aangeboden <span>/ Presented</span>
          </h2>
          <div className="queue" role="tablist" aria-label="Aangeboden documenten">
            {queue.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                className="qitem"
                aria-selected={selected === entry.id}
                onClick={() => {
                  setSelected(entry.id);
                  void inspect(entry);
                }}
              >
                <span className={`qdot ${entry.kind === 'forgery' ? 'bad' : 'ok'}`} />
                <span>
                  <span className="qname">{entry.label}</span>
                  <span className="qmeta">{entry.meta}</span>
                </span>
              </button>
            ))}
          </div>

          <div style={{ marginTop: 12 }}>
            <label className="flab" htmlFor="ensname">
              Op naam <span className="en">/ by ENS name</span>
            </label>
            <input
              id="ensname"
              className="textinput"
              value={name}
              spellCheck={false}
              onChange={(event) => {
                setName(event.target.value);
              }}
              placeholder="zegel.eth"
            />
            <span className="fnote">
              Resolved through ENSIP-10 where the resolver supports it, then ENSIP-24{' '}
              <code className="mono">data(node, &quot;zegel.envelope.v1&quot;)</code>. No wallet, no key.
            </span>
          </div>

          {records.length === 0 && (
            <Notice tone="dim">
              This browser holds no issued reference, so only the name lookup is available. Issue one on page
              05 and the forgery control appears with it.
            </Notice>
          )}
        </div>

        <div className="desk-panel">
          <div className="panelhead">
            <span>Inspectiebalie — post 04</span>
            <span>{result === null ? '—' : stampDateTime(result.at)}</span>
          </div>
          <div className="panelbody">
            <div className="scanstrip" ref={strip}>
              <div className="readhead" aria-hidden="true" />
              <div className="mrzcap">
                Machineleesbare zone gelezen <span style={{ opacity: 0.6 }}>/ MRZ read</span>
              </div>
              <div className="mrzlines">
                <div>{result?.mrz?.line1 ?? ' '}</div>
                <div>{result?.mrz?.line2 ?? ' '}</div>
              </div>
            </div>

            {busy && <p className="prose" style={{ marginTop: 12 }}>Lezen…</p>}

            {failure !== null && (
              <Notice tone="warn" title="Niet gelezen / not read">
                {failure}
              </Notice>
            )}

            {result !== null && <Inspection result={result} />}
          </div>
        </div>
      </div>

      <Footrule
        nl="Controlecijfers bewijzen dat de regel correct is gedrukt — niet dat de inhoud waar is"
        en="Check digits prove the line was printed correctly; only re-derivation proves it is true"
      />
    </section>
  );
}

function Inspection({ result }: { result: VerifyResult }): ReactNode {
  const ladder = result.mrz === null ? [] : ladderFromLine2(result.mrz.line2);
  const verdict = VERDICTS[result.verdict];

  return (
    <>
      {ladder.length > 0 && (
        <table className="ladder">
          <thead>
            <tr>
              <th className="mk" />
              <th>
                Veld <span style={{ opacity: 0.6 }}>/ Field</span>
              </th>
              <th>
                Waarde <span style={{ opacity: 0.6 }}>/ Value</span>
              </th>
              <th className="r">Gedrukt</th>
              <th className="r">Herberekend</th>
            </tr>
          </thead>
          <tbody>
            {ladder.map((row) => (
              <tr key={row.field} className={row.printed === row.recomputed ? undefined : 'fail'}>
                <td className="mk">{row.printed === row.recomputed ? '✓' : '×'}</td>
                <td>
                  {row.field} <span style={{ opacity: 0.6 }}>/ {row.fieldEn}</span>
                </td>
                <td className="mono">
                  {row.value}
                  {row.readable === undefined ? '' : `  (${row.readable})`}
                </td>
                <td className="r">{row.printed}</td>
                <td className="r">{row.recomputed}</td>
              </tr>
            ))}
            <RegisterRow result={result} />
            {result.reads.map((read) => (
              <tr key={`read-${read.tier}`} className={read.outcome.granted ? undefined : 'fail'}>
                <td className="mk">{read.outcome.granted ? '✓' : '×'}</td>
                <td>
                  Inzage niveau {read.tier} <span style={{ opacity: 0.6 }}>/ tier {read.tier} read</span>
                </td>
                <td className="mono">{read.outcome.via}</td>
                <td className="r">—</td>
                <td className="r">
                  {read.outcome.granted ? `${read.outcome.bytes} B` : read.outcome.message.slice(0, 28)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="derivebox">
        <div className="dh">
          Herafleiding uit actuele ketengegevens{' '}
          <span style={{ opacity: 0.6 }}>/ re-derivation from the recorded evidence</span>
        </div>
        <div className="db">
          <span className="h">Uitspraak / statement</span>
          <span className="h r">Opgegeven</span>
          <span className="h r">Herafgeleid</span>

          {result.commitment !== null && (
            <>
              <span className="lbl">Verzegeling van de aangeboden uitspraken</span>
              <span className={result.commitment.matches ? 'num' : 'num off'}>
                {shortHex(result.commitment.recomputed, 10, 6)}
              </span>
              <span className={result.commitment.matches ? 'num' : 'num off'}>
                {shortHex(result.commitment.expected, 10, 6)}
              </span>
            </>
          )}

          {result.rederivation?.comparisons.map((comparison) => (
            <ComparisonRow key={comparison.id} comparison={comparison} />
          ))}

          {result.rederivation === null && result.claimSet !== null && (
            <>
              <span className="lbl" style={{ opacity: 0.7 }}>
                Volledige herafleiding vereist niveau 2
              </span>
              <span className="num">tier 1</span>
              <span className="num">—</span>
            </>
          )}

          {result.claimSet === null && (
            <>
              <span className="lbl" style={{ opacity: 0.7 }}>
                Niets te vergelijken — er is niets geopend
              </span>
              <span className="num">—</span>
              <span className="num">—</span>
            </>
          )}
        </div>
      </div>

      {result.rederivation !== null && result.rederivation.mismatches.length > 0 && (
        <Notice tone="warn" title="Verschillen / mismatches">
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {result.rederivation.mismatches.map((mismatch) => (
              <li key={mismatch} style={{ marginBottom: 3 }}>
                {mismatch}
              </li>
            ))}
          </ul>
        </Notice>
      )}

      <div className="verdictrow">
        <div className="verdicttext">
          <span className="lead">{result.headline}</span>
          {result.detail}
          {result.anchor !== null && (
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
              Anchor:{' '}
              <a
                href={`${EXPLORERS.base}/address/${result.anchor.contract}`}
                target="_blank"
                rel="noreferrer"
                style={{ textDecoration: 'underline' }}
              >
                <code>{shortHex(result.anchor.contract, 10, 6)}</code>
              </a>{' '}
              on chain {result.anchor.chainId} — {result.anchor.summary}
              {result.anchor.record !== null && (
                <div style={{ marginTop: 3, opacity: 0.75 }}>
                  anchored {stampDate(result.anchor.record.anchoredAt)} by{' '}
                  <code>{shortHex(result.anchor.record.issuer, 8, 6)}</code>, expires{' '}
                  {stampDate(result.anchor.record.expiresAt)}
                  {result.anchor.record.revokedAt !== null &&
                    ` — revoked ${stampDate(result.anchor.record.revokedAt)}`}
                </div>
              )}
            </div>
          )}
        </div>
        <div>
          <Stamp
            nl={verdict.nl}
            en={verdict.en}
            tone={verdict.tone}
            sub={
              <>
                {verdict.sub}
                <br />
                {stampDateTime(result.at)}
              </>
            }
          />
        </div>
      </div>

      {result.verdict === 'tampered' && (
        <Notice tone="warn" title="De negatieve controle">
          Every check digit closes. A forger gets the 7-3-1 weights right without effort — they only prove the
          line was printed neatly. What fails is arithmetic nobody can talk their way around: the claim set in
          front of the desk does not hash to the number the issuer sealed, and the contract on Base says so
          without being asked to take anyone&apos;s word for it.
        </Notice>
      )}

      {result.verdict === 'not-granted' && (
        <Notice tone="dim" title="Waarom dit geen foutcode is">
          Swarm answers an un-granted read with a bare 404, byte-identical to the answer for content that never
          existed. There is one honest gap and we state it: a party who already holds the history address sees
          <code className="mono"> act or history entry not found</code> where a stranger sees{' '}
          <code className="mono">Not Found</code>. Against someone holding only the reference — the threat model
          that matters — the two are indistinguishable.
        </Notice>
      )}
    </>
  );
}

function ComparisonRow({
  comparison,
}: {
  comparison: { id: string; statement: string; declared: string; rederived: string; agrees: boolean };
}): ReactNode {
  return (
    <>
      <span className="lbl">{comparison.statement}</span>
      <span className={comparison.agrees ? 'num' : 'num off'}>{comparison.declared}</span>
      <span className={comparison.agrees ? 'num' : 'num off'}>{comparison.rederived}</span>
    </>
  );
}

function RegisterRow({ result }: { result: VerifyResult }): ReactNode {
  const anchored = result.anchor !== null && result.anchor.status === 'valid';
  return (
    <tr className={anchored ? undefined : 'fail'}>
      <td className="mk">{anchored ? '✓' : '×'}</td>
      <td>
        Register <span style={{ opacity: 0.6 }}>/ anchor on Base</span>
      </td>
      <td className="mono">{result.envelope === null ? '—' : shortHex(result.envelope.referenceId, 12, 8)}</td>
      <td className="r">—</td>
      <td className="r">{result.anchor?.status ?? 'unread'}</td>
    </tr>
  );
}

/**
 * The forgery.
 *
 * One number is changed and nothing else: a failing claim is flipped to passing,
 * which is the edit a subject would actually be tempted to make. Everything else
 * — the reference id, the dates, the MRZ, all five check digits — stays exactly
 * as issued, so the failure cannot be attributed to sloppiness.
 */
function forge(claimSet: ClaimSet): ClaimSet {
  const target = claimSet.claims.findIndex((claim) => !claim.passed);
  const index = target === -1 ? 0 : target;

  return {
    ...claimSet,
    claims: claimSet.claims.map((claim, position) =>
      position === index
        ? { ...claim, passed: !claim.passed, ...(claim.actual === undefined ? {} : { actual: claim.actual * 2 }) }
        : claim,
    ),
  };
}
