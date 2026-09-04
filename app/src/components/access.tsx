'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { Field, FieldGrid, Footrule, Notice, SectionHead } from '~/components/document';
import { shortHex, stampDate, stampDateTime } from '~/lib/format';
import { useReferences } from '~/lib/store';
import type {
  AccessEvent,
  AccessLedger,
  GranteeView,
  ReadReport,
  ReferenceRecord,
  StoredTier,
} from '~/lib/types';

/**
 * Page 07 — the endorsements.
 *
 * Every reader gets their own visa. None is transferable and none stays valid
 * because nobody remembered it. A withdrawal is struck through here rather than
 * swept away: what a holder already read stays on the page, because a booklet
 * that can be tidied up is worth nothing. What changes is that the same key's
 * next request gets the answer a booklet that was never issued would get.
 */
export function Access(): ReactNode {
  const { records, ready, save } = useReferences();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const record = useMemo(() => {
    if (records.length === 0) return null;
    return records.find((entry) => entry.referenceId === selectedId) ?? records[0] ?? null;
  }, [records, selectedId]);

  if (!ready) return <p className="prose" style={{ marginTop: 20 }}>Boekje openslaan…</p>;

  if (record === null) {
    return (
      <section>
        <p className="lede">Er is nog geen boekje om aantekeningen in te zetten.</p>
        <p className="prose">
          Grants are patches to a Swarm ACT grantee list attached to a sealed object, so there has to be a
          sealed object first.{' '}
          <Link href="/issue" style={{ textDecoration: 'underline' }}>
            Page 05
          </Link>{' '}
          issues one: connect the wallet you are making a claim about, sign once, and both tiers are sealed.
        </p>
        <Notice tone="dim" title="Waarom hier niets staat">
          This app keeps no server-side state. An issued reference lives in the browser that issued it, because
          the ACT history address is unrecoverable if lost and belongs with the person who would lose access.
          Nothing was forgotten — there is simply nothing in this browser yet.
        </Notice>
        <Footrule
          nl="Doorhaling werkt vanaf het moment van doorhalen — nooit met terugwerkende kracht"
          en="A withdrawal cuts off from here on; it is not an unsend"
        />
      </section>
    );
  }

  return (
    <AccessLedgerView
      key={record.referenceId}
      record={record}
      records={records}
      onSelect={setSelectedId}
      onChange={save}
    />
  );
}

function AccessLedgerView({
  record,
  records,
  onSelect,
  onChange,
}: {
  record: ReferenceRecord;
  records: readonly ReferenceRecord[];
  onSelect: (id: string) => void;
  onChange: (record: ReferenceRecord) => void;
}): ReactNode {
  const [tierNumber, setTierNumber] = useState<1 | 2>(record.tiers[0]?.tier ?? 1);
  const tier = record.tiers.find((entry) => entry.tier === tierNumber) ?? record.tiers[0];

  const [ledger, setLedger] = useState<AccessLedger | null>(null);
  const [loading, setLoading] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; detail?: string; hint?: string } | null>(null);
  const [read, setRead] = useState<ReadReport | null>(null);
  const [reading, setReading] = useState(false);
  const [justRevoked, setJustRevoked] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (tier === undefined) return;
    setLoading(true);
    try {
      const response = await fetch('/api/access/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ referenceId: record.referenceId, tier }),
      });
      setLedger((await response.json()) as AccessLedger);
    } catch (cause) {
      setLedger({
        tier: tierNumber,
        grantees: [],
        available: false,
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setLoading(false);
    }
  }, [record.referenceId, tier, tierNumber]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const patch = useCallback(
    async (action: 'grant' | 'revoke', publicKeys: readonly string[]) => {
      if (tier === undefined) return;
      setBusy(action);
      setError(null);
      try {
        const response = await fetch(`/api/access/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ referenceId: record.referenceId, tier, publicKeys }),
        });
        const body = (await response.json()) as {
          error?: string;
          detail?: string;
          hint?: string;
          tier?: StoredTier;
          grantees?: GranteeView[];
          added?: GranteeView[];
          revoked?: GranteeView[];
          previous?: { swarmRef: string };
          at?: string;
        };

        if (!response.ok || body.tier === undefined) {
          setError({
            message: body.error ?? `HTTP ${response.status}`,
            ...(body.detail === undefined ? {} : { detail: body.detail }),
            ...(body.hint === undefined ? {} : { hint: body.hint }),
          });
          return;
        }

        const changed = action === 'grant' ? (body.added ?? []) : (body.revoked ?? []);
        const events: AccessEvent[] = changed.map((view) => ({
          action,
          publicKey: view.publicKey,
          address: view.address,
          tier: tierNumber,
          at: body.at ?? new Date().toISOString(),
          previousRef: body.previous?.swarmRef ?? tier.swarmRef,
        }));

        const updatedTiers = record.tiers.map((entry) =>
          entry.tier === tierNumber ? (body.tier as StoredTier) : entry,
        );

        onChange({
          ...record,
          tiers: updatedTiers,
          envelope: {
            ...record.envelope,
            tiers: record.envelope.tiers.map((entry) =>
              entry.tier === tierNumber
                ? {
                    tier: entry.tier,
                    swarmRef: (body.tier as StoredTier).swarmRef,
                    actHistoryAddress: (body.tier as StoredTier).actHistoryAddress,
                    actPublisher: (body.tier as StoredTier).actPublisher,
                  }
                : entry,
            ),
          },
          history: [...(record.history ?? []), ...events],
        });

        setLedger({
          tier: tierNumber,
          grantees: body.grantees ?? [],
          available: true,
          detail: 'read back from the publisher node immediately after the patch',
        });
        if (action === 'revoke') setJustRevoked(changed[0]?.publicKey ?? null);
        setRead(null);
        if (action === 'grant') setNewKey('');
      } catch (cause) {
        setError({ message: cause instanceof Error ? cause.message : String(cause) });
      } finally {
        setBusy(null);
      }
    },
    [onChange, record, tier, tierNumber],
  );

  const doRead = useCallback(async () => {
    if (tier === undefined) return;
    setReading(true);
    try {
      const response = await fetch('/api/access/read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
      setRead((await response.json()) as ReadReport);
    } finally {
      setReading(false);
    }
  }, [tier]);

  const live = ledger?.grantees ?? [];
  const liveKeys = new Set(live.map((view) => view.publicKey));
  const withdrawn = (record.history ?? []).filter(
    (event) => event.action === 'revoke' && event.tier === tierNumber && !liveKeys.has(event.publicKey),
  );
  const expired = Date.parse(record.expiresAt) < Date.now();

  return (
    <section>
      <div className="split">
        <div>
          <p className="lede" style={{ marginTop: 0 }}>
            Elke lezer krijgt een eigen visum. Geen enkel visum is overdraagbaar en geen enkel visum blijft
            geldig omdat niemand eraan denkt.
          </p>
          <p className="prose">
            A withdrawal is struck through here, not swept away. What a holder already read stays on the page,
            because a booklet that can be tidied up is worth nothing. What changes is that the same key&apos;s
            next request gets the same answer as a request for a booklet that was never issued.
          </p>
        </div>
        <div className="tally" style={{ marginTop: 0, flexDirection: 'column' }}>
          <div>
            <span className="n">{live.length}</span>
            <span className="l">Geldige visa / valid</span>
          </div>
          <div>
            <span className="n warn">{withdrawn.length}</span>
            <span className="l">Doorgehaald / withdrawn</span>
          </div>
          <div>
            <span className="n grey">{expired ? 1 : 0}</span>
            <span className="l">Verlopen / lapsed</span>
          </div>
        </div>
      </div>

      <FieldGrid>
        <Field
          nl="Boekje"
          en="Booklet"
          tone="mono"
          value={
            records.length > 1 ? (
              <select
                className="textinput"
                value={record.referenceId}
                onChange={(event) => {
                  onSelect(event.target.value);
                }}
              >
                {records.map((entry) => (
                  <option key={entry.referenceId} value={entry.referenceId}>
                    {shortHex(entry.referenceId, 12, 8)} — {entry.ensName ?? 'geen naam'}
                  </option>
                ))}
              </select>
            ) : (
              shortHex(record.referenceId, 14, 10)
            )
          }
        />
        <Field
          nl="Geldig tot"
          en="Expires"
          tone={expired ? 'orange' : 'plain'}
          value={stampDate(record.expiresAt)}
          note={expired ? 'Deze referentie is verlopen; niemand heeft iets ingetrokken.' : undefined}
        />
        <Field
          nl="Niveau"
          en="Tier"
          value={
            <span style={{ display: 'inline-flex', gap: 8 }}>
              {record.tiers.map((entry) => (
                <button
                  key={entry.tier}
                  type="button"
                  className="btn small plain"
                  aria-pressed={entry.tier === tierNumber}
                  style={
                    entry.tier === tierNumber
                      ? { background: 'var(--blue)', color: 'var(--stock)' }
                      : undefined
                  }
                  onClick={() => {
                    setTierNumber(entry.tier);
                    setRead(null);
                  }}
                >
                  Niveau {entry.tier}
                </button>
              ))}
            </span>
          }
          note={
            tierNumber === 1
              ? 'Tier 1 carries the assertions and no amounts. The reader never learns the address.'
              : 'Tier 2 carries the raw upstream bodies and the address, so the reader can redo the derivation themselves.'
          }
        />
        <Field
          nl="Huidige verzegeling"
          en="Current sealed object"
          tone="mono"
          value={tier === undefined ? '—' : shortHex(tier.swarmRef, 14, 10)}
          note={tier === undefined ? undefined : `act history ${shortHex(tier.actHistoryAddress, 12, 8)}`}
        />
      </FieldGrid>

      <SectionHead nl="Visa en aantekeningen" en="Visas and endorsements" />

      {ledger !== null && !ledger.available && (
        <Notice tone="warn" title="Geen knooppunt / no node">
          {ledger.detail}
          <div style={{ marginTop: 6 }}>
            Grant and revoke live behind <code className="mono">POST /grantee</code>, which the public Swarm
            gateway answers with 404, and the ACT publisher private key has to belong to a node we run. There
            is no honest degraded mode here, so this refuses rather than reporting a grant that did not happen.
          </div>
        </Notice>
      )}

      <div className="visas">
        {live.map((view) => (
          <Visa
            key={view.publicKey}
            view={view}
            tier={tierNumber}
            state={expired ? 'lapsed' : 'valid'}
            granted={(record.history ?? []).find(
              (event) => event.action === 'grant' && event.publicKey === view.publicKey,
            )}
            expiresAt={record.expiresAt}
            busy={busy === 'revoke'}
            onRevoke={() => void patch('revoke', [view.publicKey])}
          />
        ))}
        {withdrawn.map((event) => (
          <Visa
            key={`revoked-${event.publicKey}-${event.at}`}
            view={{ publicKey: event.publicKey, address: event.address }}
            tier={event.tier}
            state="withdrawn"
            withdrawnAt={event.at}
            previousRef={event.previousRef}
            expiresAt={record.expiresAt}
            fresh={justRevoked === event.publicKey}
          />
        ))}
      </div>

      {live.length === 0 && ledger?.available === true && (
        <Notice tone="dim">
          The grantee list for tier {tierNumber} is empty right now. {ledger.detail}
        </Notice>
      )}

      <div className="act">
        <input
          className="textinput"
          style={{ maxWidth: 520 }}
          value={newKey}
          spellCheck={false}
          placeholder="03c2694c2b58816f61b1437bd4f58b84b06cd52f80c3fb5dd7dc34adcdd7314cea"
          aria-label="Compressed secp256k1 public key of the reader to add"
          onChange={(event) => {
            setNewKey(event.target.value);
          }}
        />
        <button
          className="btn"
          type="button"
          disabled={newKey.trim() === '' || busy !== null}
          onClick={() => void patch('grant', [newKey.trim()])}
        >
          {busy === 'grant' ? 'afgeven…' : 'Visum afgeven / grant'}
        </button>
        <button className="btn plain small" type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'lezen…' : 'lijst opnieuw lezen'}
        </button>
      </div>

      <p className="prose" style={{ marginTop: 8, fontSize: 11.5, opacity: 0.75 }}>
        A grantee is a compressed secp256k1 public key — 66 hex characters starting 02 or 03. Not an address:
        an address is a hash and cannot take part in the key exchange ACT uses. Grantee patches are serialised
        with a 1.1 second floor, because Bee keys each history version on the wall-clock second and two writes
        inside one second collide.
      </p>

      {error !== null && (
        <Notice tone="warn" title="Geweigerd, niet nagebootst / refused, not faked">
          {error.message}
          {error.detail !== undefined && <div style={{ marginTop: 5 }}>{error.detail}</div>}
          {error.hint !== undefined && (
            <div style={{ marginTop: 5, opacity: 0.8 }}>{error.hint}</div>
          )}
        </Notice>
      )}

      <SectionHead nl="Laat de lezer lezen" en="Let the reader read" />
      <p className="prose">
        The same object, asked for from three positions at once: the grantee&apos;s own Bee node with the ACT
        credentials, the same node with no credentials at all, and the publisher. The third request is why this
        is a demonstration rather than a claim — without it, a 404 at the grantee could be an object that
        quietly vanished.
      </p>

      <div className="act">
        <button className="btn" type="button" onClick={() => void doRead()} disabled={reading || tier === undefined}>
          {reading ? 'lezen…' : 'Aanbieden ter inzage / attempt the read'}
        </button>
        <span className="hint">
          Nothing is cached. Grant, read, revoke, read again — the second read is the whole product.
        </span>
      </div>

      {read !== null && <ReadPanel report={read} />}

      <Notice tone="dim" title="Eerlijke grens / the honest limit">
        Revocation is forward-only. A reader who already downloaded a version keeps it, and can still fetch
        that version by supplying the timestamp they were granted at. Every patch produces a new history and
        the content is written again under it, so a withdrawn key is cut off from everything sealed from that
        moment on — never from what they already hold. A reference system that claimed otherwise would be
        lying.
      </Notice>

      <Footrule
        nl="Doorhaling werkt vanaf het moment van doorhalen — nooit met terugwerkende kracht"
        en="A withdrawal cuts off from here on; it is not an unsend"
      />
    </section>
  );
}

function Visa({
  view,
  tier,
  state,
  granted,
  withdrawnAt,
  previousRef,
  expiresAt,
  busy,
  fresh,
  onRevoke,
}: {
  view: GranteeView;
  tier: 1 | 2;
  state: 'valid' | 'withdrawn' | 'lapsed';
  granted?: AccessEvent | undefined;
  withdrawnAt?: string;
  previousRef?: string;
  expiresAt: string;
  busy?: boolean;
  fresh?: boolean;
  onRevoke?: () => void;
}): ReactNode {
  const cls = state === 'withdrawn' ? 'visa cancelled' : state === 'lapsed' ? 'visa lapsed' : 'visa';

  return (
    <div className={cls}>
      <div className="vg" aria-hidden="true" />
      <div className="visahead">
        <span>Visum — inzage</span>
        <span>TIER {tier}</span>
      </div>
      <div className="visabody">
        <div className="visaname">{view.publicKey}</div>
        <div className="visarole">
          key hashes to {shortHex(view.address, 10, 6)} — the reader decrypts on their own Bee node with their
          own key
        </div>
        <div className="visafields">
          <div>
            <span className="k">Niveau / Level</span>
            <span className="v">TIER {tier}</span>
          </div>
          <div>
            <span className="k">Afgegeven / Granted</span>
            <span className="v">{granted === undefined ? 'bij afgifte' : stampDateTime(granted.at)}</span>
          </div>
          <div>
            <span className="k">{state === 'withdrawn' ? 'Doorgehaald / Withdrawn' : 'Geldig tot / Expires'}</span>
            <span className="v">
              {state === 'withdrawn' && withdrawnAt !== undefined
                ? stampDateTime(withdrawnAt)
                : stampDate(expiresAt)}
            </span>
          </div>
          {previousRef !== undefined && (
            <div>
              <span className="k">Kon lezen tot / Could read</span>
              <span className="v">{shortHex(previousRef, 10, 6)}</span>
            </div>
          )}
        </div>
        <div className="visafoot">
          <span className={state === 'withdrawn' ? 'vstate off' : state === 'lapsed' ? 'vstate grey' : 'vstate'}>
            {state === 'withdrawn'
              ? 'Doorgehaald / withdrawn'
              : state === 'lapsed'
                ? 'Verlopen / lapsed'
                : 'Geldig / valid'}
          </span>
          {state === 'valid' && onRevoke !== undefined ? (
            <button className="btn warn small" type="button" disabled={busy === true} onClick={onRevoke}>
              {busy === true ? 'intrekken…' : 'Intrekken / withdraw'}
            </button>
          ) : (
            <span style={{ fontSize: 11, opacity: 0.7 }}>
              eerdere inzagen blijven staan en zijn niet terug te halen
            </span>
          )}
        </div>
      </div>
      <div className="entrystamp" aria-hidden="true">
        <b>{tier}</b>
        <small>niveau</small>
      </div>
      {state === 'withdrawn' && (
        <div className="cancelstamp" style={fresh === true ? undefined : { animation: 'none' }}>
          Ingetrokken
          <small>withdrawn {withdrawnAt === undefined ? '' : stampDate(withdrawnAt).toLowerCase()}</small>
        </div>
      )}
    </div>
  );
}

function ReadPanel({ report }: { report: ReadReport }): ReactNode {
  const rows: {
    what: string;
    said: string;
    code: string;
    ok: boolean;
  }[] = [];

  if ('unavailable' in report.reader) {
    rows.push({
      what: 'De lezer / the grantee',
      said: report.reader.detail,
      code: 'no node',
      ok: false,
    });
  } else if (report.reader.granted) {
    rows.push({
      what: 'De lezer / the grantee',
      said: `${report.reader.bytes} bytes decrypted on their own node${
        report.reader.schema === null ? '' : ` — ${report.reader.schema}`
      } — ${report.reader.via}`,
      code: String(report.reader.status),
      ok: true,
    });
  } else {
    rows.push({
      what: 'De lezer / the grantee',
      said: `"${report.reader.message}" — ${report.reader.via}`,
      code: String(report.reader.status),
      ok: false,
    });
  }

  rows.push({
    what: 'De wereld / anyone at all',
    said: report.anonymous.granted
      ? `${report.anonymous.bytes} bytes returned without credentials — this object is not access-controlled`
      : `"${report.anonymous.message}" — ${report.anonymous.via}`,
    code: String(report.anonymous.status),
    ok: !report.anonymous.granted,
  });

  rows.push({
    what: 'De uitgever / the publisher',
    said: report.publisher.granted
      ? `${report.publisher.bytes} bytes — the object exists and is intact, so any 404 above is access, not absence`
      : `"${report.publisher.message}" — the publisher cannot read its own object, which is a fault, not a privacy outcome`,
    code: String(report.publisher.status),
    ok: report.publisher.granted,
  });

  return (
    <div className="readpanel">
      <div className="rh">
        <span>Inzageverzoeken — post 04</span>
        <span>{stampDateTime(report.at)}</span>
      </div>
      {rows.map((row) => (
        <div key={row.what} className={row.ok ? 'readrow' : 'readrow bad'}>
          <span className="mk">{row.ok ? '✓' : '×'}</span>
          <span>
            <span className="what">{row.what}</span>
            <span className="said">{row.said}</span>
          </span>
          <span className="code">HTTP {row.code}</span>
        </div>
      ))}
    </div>
  );
}
