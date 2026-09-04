'use client';

import Link from 'next/link';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useAccount, useSignMessage, useSwitchChain, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';

import { Field, FieldGrid, Footrule, Mrz, Notice, SectionHead, WithheldWindow } from '~/components/document';
import { useCreditMeter } from '~/components/health';
import { ANCHOR_WRITE_ABI } from '~/lib/anchorAbi';
import { ANCHOR_ADDRESS, DEFAULT_EXPIRY_DAYS, EXPLORERS } from '~/lib/config';
import { byUnit, shortHex, stampDate, thresholdText } from '~/lib/format';
import { buildMrz, documentNumber } from '~/lib/mrz';
import { readNdjson } from '~/lib/ndjson';
import { useReferences } from '~/lib/store';
import type { CreditMeter, IssueResult, ReferenceRecord, SealOutcome } from '~/lib/types';
import type { Claim, ClaimSet, SealedEnvelope } from '@zegel/sdk/types';

type Phase = 'idle' | 'signing' | 'collecting' | 'sealing' | 'done' | 'refused';

interface Derived {
  claims: readonly Claim[];
  claimSet: ClaimSet;
  commitment: string;
  derivationId: string;
  window: { from: string; to: string };
  missing: readonly { id: string; statement: string; reason: string }[];
  negativeControl: { ok: boolean; mismatches: readonly string[] };
}

/**
 * Page 05 — the data page.
 *
 * The only screen in this booklet that needs a wallet, and it needs one for a
 * reason that is worth saying out loud: a reference is an assertion about
 * somebody's money, and the only person who gets to make it is the person who can
 * sign for the wallet. There is no operator override here and no "issue on behalf
 * of". That refusal is the feature.
 */
export function Issue(): ReactNode {
  const { address, isConnected, chainId } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { setMeter } = useCreditMeter();
  const { save } = useReferences();

  const [phase, setPhase] = useState<Phase>('idle');
  const [log, setLog] = useState<{ text: string; bad: boolean }[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);

  const [readerKeys, setReaderKeys] = useState('');
  const [expiresDays, setExpiresDays] = useState(DEFAULT_EXPIRY_DAYS);
  const [tier, setTier] = useState<1 | 2>(1);

  const [ensName, setEnsName] = useState<string | null>(null);
  const [derived, setDerived] = useState<Derived | null>(null);
  const [seal, setSeal] = useState<SealOutcome | null>(null);
  const [envelope, setEnvelope] = useState<SealedEnvelope | null>(null);
  const [record, setRecord] = useState<ReferenceRecord | null>(null);
  const [referenceId, setReferenceId] = useState<string | null>(null);

  const line = useCallback((text: string, bad = false) => {
    setLog((lines) => [...lines, { text, bad }]);
  }, []);

  const run = useCallback(async () => {
    if (address === undefined) return;

    setPhase('signing');
    setError(null);
    setLog([]);
    setProgress(null);
    setDerived(null);
    setSeal(null);
    setEnvelope(null);
    setRecord(null);
    setMeter(null);

    let prepared: { referenceId: string; message: string };
    try {
      const response = await fetch('/api/issue/prepare', { method: 'POST' });
      prepared = (await response.json()) as { referenceId: string; message: string };
      setReferenceId(prepared.referenceId);
      line(`reference ${prepared.referenceId}`);
    } catch (cause) {
      setError({ message: cause instanceof Error ? cause.message : String(cause) });
      setPhase('refused');
      return;
    }

    let signature: string;
    try {
      line(`asking ${address} to sign "${prepared.message}"`);
      signature = await signMessageAsync({ message: prepared.message });
    } catch (cause) {
      setError({
        message: 'the control proof was not signed, so nothing was issued',
        detail:
          cause instanceof Error && cause.message !== ''
            ? cause.message
            : 'The wallet declined or the request was dismissed.',
      });
      setPhase('refused');
      return;
    }

    setPhase('collecting');

    try {
      const response = await fetch('/api/issue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address,
          referenceId: prepared.referenceId,
          signature,
          grantees: readerKeys
            .split(/[\s,]+/)
            .map((value) => value.trim())
            .filter((value) => value !== ''),
          expiresDays,
        }),
      });

      if (!response.ok) {
        const body = (await response.json()) as { error?: string; detail?: string };
        setError({ message: body.error ?? `HTTP ${response.status}`, ...(body.detail === undefined ? {} : { detail: body.detail }) });
        setPhase('refused');
        return;
      }

      await readNdjson(response, (event) => {
        switch (event['type']) {
          case 'proof':
            line(`control proof accepted — recovered ${String(event['signer'])}`);
            break;
          case 'name':
            setEnsName((event['ensName'] as string | null) ?? null);
            break;
          case 'source':
            line(
              `collecting from ${String(event['host'])}${event['keyed'] === true ? ' with a key' : ' — no key, no signup'}`,
            );
            break;
          case 'progress':
            setProgress({ done: Number(event['done']), total: Number(event['total']) });
            line(
              `[${String(event['done'])}/${String(event['total'])}] ${String(event['endpoint'])} ${String(event['status'])}`,
              event['status'] === 'unavailable',
            );
            break;
          case 'credits':
            setMeter({
              spent: Number(event['spent'] ?? 0),
              latest: (event['snapshot'] ?? null) as CreditMeter['latest'],
              host: '',
              keyed: false,
            });
            break;
          case 'claims':
            setDerived({
              claims: event['claims'] as Claim[],
              claimSet: event['claimSet'] as ClaimSet,
              commitment: String(event['commitment']),
              derivationId: String(event['derivationId']),
              window: event['window'] as { from: string; to: string },
              missing: event['missing'] as Derived['missing'],
              negativeControl: event['negativeControl'] as Derived['negativeControl'],
            });
            setPhase('sealing');
            break;
          case 'backend':
            line(
              `sealing through ${String((event['backend'] as { kind: string }).kind)} at ${String(
                (event['backend'] as { url: string }).url,
              )}`,
            );
            for (const warning of (event['warnings'] as string[] | undefined) ?? []) line(warning, true);
            break;
          case 'note':
            line(String(event['message']));
            break;
          case 'sealing':
            line(`sealing tier ${String(event['tier'])}…`);
            break;
          case 'sealed':
            line(
              `tier ${String(event['tier'])} sealed — ${String(event['bytes'])} bytes, ref ${String(
                event['swarmRef'],
              ).slice(0, 16)}…`,
            );
            break;
          case 'unpublishable':
            line(`tier ${String(event['tier'])} sealed but cannot be published: ${String(event['detail'])}`, true);
            break;
          case 'sealFailed':
            line(`nothing was sealed: ${String(event['error'])}`, true);
            break;
          case 'issued': {
            const outcome = event['seal'] as SealOutcome;
            setSeal(outcome);
            setEnvelope(event['envelope'] as SealedEnvelope);
            const stored = event['record'] as ReferenceRecord | null;
            if (stored !== null) {
              setRecord(stored);
              save(stored);
              line('kept in this browser — the ACT history address cannot be recovered if it is lost');
            }
            setMeter(event['credits'] as CreditMeter);
            setPhase('done');
            break;
          }
          case 'error':
            setError({ message: String(event['message']) });
            setPhase('refused');
            break;
          default:
            break;
        }
      });
    } catch (cause) {
      setError({ message: cause instanceof Error ? cause.message : String(cause) });
      setPhase('refused');
    }
  }, [address, expiresDays, line, readerKeys, save, setMeter, signMessageAsync]);

  const mrz = useMemo(() => {
    if (envelope === null) return null;
    return buildMrz({
      name: ensName,
      referenceId: envelope.referenceId,
      commitment: envelope.commitment,
      recordFrom: derived?.window.from ?? envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      tier,
    });
  }, [derived, ensName, envelope, tier]);

  const busy = phase === 'signing' || phase === 'collecting' || phase === 'sealing';

  return (
    <section>
      <div className="identblock">
        <WithheldWindow />
        <div className="windowbody">
          <p className="lede">
            Elk identiteitsdocument heeft een venster. In dit document is dat venster met opzet leeg.
          </p>
          <p>
            Every other document puts, in that space, the one datum that opens everything behind it. Here there
            is nothing. The hatched panel is not a missing image and not a printing fault: it is the promise of
            the document. The name is public, the wallet is secret, and the reader gets the assertions without
            the key to the rest.
          </p>
          <p style={{ opacity: 0.75, fontSize: 11.5 }}>
            Said plainly: at tier 2 the reader does learn the address. The privacy is from the world, not from
            the counterparty you chose yourself.
          </p>
        </div>
      </div>

      <FieldGrid>
        <Field nl="Type" en="Type" tone="mono" value="PZ" />
        <Field
          nl="Uitgevende naamruimte"
          en="Issuing namespace"
          tone="mono"
          value="ENS"
          note="Not a country. The authority that issued this identity is a name registry."
        />
        <Field
          nl="Documentnummer"
          en="Document no."
          tone="mono"
          value={referenceId === null ? '—' : documentNumber(referenceId)}
          note={referenceId === null ? undefined : referenceId}
        />
        <Field
          nl="Naam"
          en="Name"
          tone="big"
          value={ensName === null ? (isConnected ? 'GEEN PRIMAIRE NAAM' : '—') : ensName.toUpperCase()}
          note={
            ensName === null && isConnected
              ? 'This wallet has no ENS primary name, so the document is issued anonymously under its reference id.'
              : undefined
          }
        />
        <Field
          nl="Portefeuille"
          en="Wallet"
          tone="orange"
          value="— NIET AFGEGEVEN / WITHHELD —"
          note={
            isConnected && address !== undefined
              ? `Proven to this browser as ${shortHex(address, 10, 6)}; never written into the public envelope.`
              : undefined
          }
        />
        <Field
          nl="Aard van het document"
          en="Nature of document"
          value="PERSOONLIJKE FINANCIËLE REFERENTIE"
        />
        <Field
          nl="Datum van afgifte"
          en="Date of issue"
          value={envelope === null ? '—' : stampDate(envelope.issuedAt)}
        />
        <Field
          nl="Geldig tot"
          en="Date of expiry"
          tone="orange"
          value={envelope === null ? `${expiresDays} dagen na afgifte` : stampDate(envelope.expiresAt)}
        />
        <Field
          nl="Autoriteit van afgifte"
          en="Issuing authority"
          value={ensName === null ? 'ZELF AFGEGEVEN / SELF-ISSUED' : ensName.toUpperCase()}
          note="Self-issued, and re-derived from live data at every inspection rather than from a stored judgement."
        />
        <Field
          nl="Verzegeling"
          en="Commitment"
          tone="mono"
          value={derived === null ? '—' : shortHex(derived.commitment, 18, 10)}
          note={derived === null ? undefined : `sha256 over the canonical tier-1 claim set · derivation ${shortHex(derived.derivationId, 12, 8)}`}
        />
      </FieldGrid>

      <SectionHead nl="Afgifte" en="Issue" />

      {!isConnected && (
        <Notice tone="warn" title="Geen bewijs van zeggenschap / no control proof">
          Issuing needs a signature from the subject wallet itself. Connect a wallet in the desk bar above.
          Nothing here can be issued for an address you have not proven you control — not by an operator, not
          by an admin, not by pasting one in. Every read page of this booklet works without a wallet; this one
          cannot, and should not.
        </Notice>
      )}

      <div className="fieldgrid" style={{ marginTop: 10 }}>
        <div className="field">
          <label className="flab" htmlFor="readers">
            Lezers bij afgifte <span className="en">/ readers at issue</span>
          </label>
          <textarea
            id="readers"
            className="textinput"
            value={readerKeys}
            spellCheck={false}
            placeholder="03c2694c2b58816f61b1437bd4f58b84b06cd52f80c3fb5dd7dc34adcdd7314cea"
            onChange={(event) => {
              setReaderKeys(event.target.value);
            }}
          />
          <span className="fnote">
            Compressed secp256k1 public keys, 66 hex characters, one per line. A public key, not an address —
            an address is a hash and cannot take part in the key exchange ACT uses. Leave it empty and the
            grantee list opens with the publisher key alone, so readers can still be added on page 07.
          </span>
        </div>
        <div className="field">
          <label className="flab" htmlFor="expires">
            Geldigheidsduur <span className="en">/ valid for</span>
          </label>
          <input
            id="expires"
            className="textinput"
            type="number"
            min={1}
            max={365}
            value={expiresDays}
            onChange={(event) => {
              setExpiresDays(Number(event.target.value));
            }}
          />
          <span className="fnote">
            Days. A reference that never lapses is a reference you have to remember to withdraw.
          </span>
        </div>
      </div>

      <div className="act">
        <button className="btn" type="button" onClick={() => void run()} disabled={!isConnected || busy}>
          {phase === 'signing'
            ? 'wacht op handtekening…'
            : phase === 'collecting'
              ? 'verzamelen…'
              : phase === 'sealing'
                ? 'zegelen…'
                : 'Zegelen en afgeven'}
        </button>
        <span className="hint">
          Sign once. The claims are derived from live data, both tiers are sealed under ACT on Swarm, and the
          public envelope is printed below. Nothing in it identifies the wallet.
        </span>
      </div>

      {progress !== null && busy && (
        <div className="progressbar" aria-hidden="true">
          <i style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
        </div>
      )}

      {log.length > 0 && (
        <div className="progresslog" role="log" aria-live="polite">
          {log.map((entry, index) => (
            <div key={`${index}-${entry.text}`} className={entry.bad ? 'bad' : ''}>
              {entry.text}
            </div>
          ))}
        </div>
      )}

      {error !== null && (
        <Notice tone="warn" title="Geweigerd / refused">
          {error.message}
          {error.detail !== undefined && <div style={{ marginTop: 5, opacity: 0.8 }}>{error.detail}</div>}
        </Notice>
      )}

      {derived !== null && <Claims derived={derived} />}

      {seal !== null && <SealReport seal={seal} record={record} />}

      {envelope !== null && (
        <>
          <SectionHead nl="Openbaarmakingsniveau" en="Disclosure level" />
          <div className="tierrow">
            {(
              [
                [1, 'Niveau 1', 'The assertions themselves. Which bars were cleared, no amounts, none of page 03.'],
                [2, 'Niveau 2', 'The full evidence with its derivation, so the reader can redo the sum instead of believing it.'],
              ] as const
            ).map(([value, label, description]) => (
              <button
                key={value}
                type="button"
                className="tierbtn"
                aria-pressed={tier === value}
                onClick={() => {
                  setTier(value);
                }}
              >
                <span className="tn">{label}</span>
                <span className="td">{description}</span>
              </button>
            ))}
            <div className="tierbtn" aria-hidden="true" style={{ opacity: 0.7, cursor: 'default' }}>
              <span className="tn">Openbaar</span>
              <span className="td">
                The commitment only. The world learns that a reference exists and nothing else — that is the
                envelope below, and it needs no grant at all.
              </span>
            </div>
          </div>

          {mrz !== null && (
            <Mrz
              line1={mrz.line1}
              line2={mrz.line2}
              footnote={`Check digits over document number, dates and the commitment prefix — weights 7-3-1, recomputed here and ${
                mrz.wellFormed ? 'they close' : 'they do not close'
              }`}
              status={`Gezegeld ${stampDate(envelope.issuedAt)} · niveau ${tier}`}
            />
          )}

          <SectionHead nl="Het openbare omslag" en="The public envelope" />
          <p className="prose">
            This is the half that goes on the name. It says a reference exists, when it expires and where the
            ciphertext lives. It carries no address and no claim text.
          </p>
          <dl className="kv">
            <dt>Reference</dt>
            <dd>{envelope.referenceId}</dd>
            <dt>Commitment</dt>
            <dd>{envelope.commitment}</dd>
            <dt>Verloopt / expires</dt>
            <dd>{envelope.expiresAt}</dd>
            {envelope.tiers.map((sealed) => (
              <FragmentTier key={sealed.tier} tier={sealed.tier} swarmRef={sealed.swarmRef} history={sealed.actHistoryAddress} />
            ))}
            <dt>Intrekking zichtbaar op</dt>
            <dd>
              {envelope.revocationHint.contract} (chain {envelope.revocationHint.chainId})
            </dd>
          </dl>

          <AnchorControl envelope={envelope} record={record} chainId={chainId} />
        </>
      )}

      <Footrule
        nl="Afgifte vereist een handtekening van de portefeuille zelf"
        en="Issuing requires a signature from the wallet itself"
      />
    </section>
  );
}

function FragmentTier({
  tier,
  swarmRef,
  history,
}: {
  tier: number;
  swarmRef: string;
  history: string;
}): ReactNode {
  return (
    <>
      <dt>Niveau {tier} op Swarm</dt>
      <dd>
        bzz://{swarmRef}
        <br />
        <span style={{ opacity: 0.7 }}>act history {history}</span>
      </dd>
    </>
  );
}

function Claims({ derived }: { derived: Derived }): ReactNode {
  const passed = derived.claims.filter((claim) => claim.passed).length;

  return (
    <>
      <SectionHead nl="Bevestigde uitspraken" en="Asserted statements" />
      <p className="prose">
        Ten rules, the same for every reference, hashed into a derivation id so two references are known to
        have been scored by the same bar. The failures are printed as loudly as the passes — a reference that
        only ever flatters its subject is worth nothing to the person reading it.
      </p>

      <ul className="assert">
        {derived.claims.map((claim) => (
          <li key={claim.id}>
            <span className="abox" role="img" aria-hidden="true" aria-checked={claim.passed} />
            <span className="at">
              {claim.statement}
              <span className="sm" style={{ display: 'block', fontSize: 10.5, opacity: 0.6, marginTop: 2 }}>
                {claim.id} · bar {thresholdText(claim)} · {claim.sources.length} source
                {claim.sources.length === 1 ? '' : 's'}
              </span>
            </span>
            <span className="av">{claim.actual === undefined ? '—' : byUnit(claim.actual, claim.unit)}</span>
            <span className={claim.passed ? 'as' : 'as no'}>{claim.passed ? 'gedekt' : 'niet gedekt'}</span>
          </li>
        ))}
      </ul>

      <div className="act">
        <span className="hint">
          {passed} of {derived.claims.length} asserted statements are covered by the evidence.
          {derived.missing.length > 0 &&
            ` ${derived.missing.length} more could not be computed at all and were left out rather than defaulted.`}
        </span>
      </div>

      {derived.missing.length > 0 && (
        <Notice tone="dim" title="Niet afleidbaar / not derivable">
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {derived.missing.map((entry) => (
              <li key={entry.id} style={{ marginBottom: 3 }}>
                <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{entry.id}</code> — {entry.reason}
              </li>
            ))}
          </ul>
        </Notice>
      )}

      <Notice
        tone={derived.negativeControl.ok ? 'plain' : 'warn'}
        title="Negatieve controle / negative control"
      >
        {derived.negativeControl.ok
          ? 'Re-deriving every claim from the stored upstream bodies reproduces this claim set exactly. A grantee runs the same function against the same bodies — they do not have to trust the issuer.'
          : 'Re-derivation does not reproduce this claim set.'}
        {derived.negativeControl.mismatches.length > 0 && (
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {derived.negativeControl.mismatches.map((mismatch) => (
              <li key={mismatch}>{mismatch}</li>
            ))}
          </ul>
        )}
      </Notice>

      <Notice tone="dim">
        There is no way to pick which statements to assert. The derivation has no opinion and cannot be
        persuaded; a reference whose author chooses the flattering half is a reference nobody should believe.
        What you choose is who may read it, and at which tier — page 07.
      </Notice>
    </>
  );
}

function SealReport({ seal, record }: { seal: SealOutcome; record: ReferenceRecord | null }): ReactNode {
  return (
    <>
      <SectionHead nl="Verzegeling" en="Sealing" />
      {seal.backend === null ? (
        <Notice tone="warn" title="Niets verzegeld / nothing sealed">
          {seal.error ??
            'No Swarm backend answered. The claims above are still derived and the commitment is still real, but nothing was sealed, so nothing can be granted.'}
        </Notice>
      ) : (
        <>
          <dl className="kv">
            <dt>Backend</dt>
            <dd>
              {seal.backend.kind} at {seal.backend.url}
            </dd>
            <dt>Vertrouwelijkheid</dt>
            <dd>
              {seal.backend.confidentiality === 'key-bound'
                ? 'key-bound — grantees decrypt with their own key'
                : 'obscurity — the operator of that endpoint holds the publisher key'}
            </dd>
            <dt>Grant / revoke</dt>
            <dd>{seal.backend.canManageGrantees ? 'available' : 'unavailable on this backend'}</dd>
          </dl>
          {seal.backend.limitations.length > 0 && (
            <Notice tone="dim" title="Beperkingen van deze backend">
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {seal.backend.limitations.map((limitation) => (
                  <li key={limitation} style={{ marginBottom: 3 }}>
                    {limitation}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
        </>
      )}

      {seal.unpublishable > 0 && (
        <Notice tone="warn">
          {seal.unpublishable} tier(s) reached Swarm but cannot go into the envelope, because that backend
          never exposed its ACT publisher key and no reader could open them. The commitment above is real
          regardless — it is a hash of the claim set, not of anything Swarm returned. What is missing is a
          reader path.
        </Notice>
      )}

      {record !== null && (
        <Notice title="Bewaard in deze browser / kept in this browser">
          The three ACT coordinates for {record.tiers.length} sealed tier(s) are in this browser&apos;s local
          storage and nowhere else. There is no database behind this app and no filesystem on the deployment
          target — and the ACT history address cannot be recovered from Swarm, from the reference or from the
          publisher key. Clear this browser and the reference is gone.{' '}
          <Link href="/access" style={{ textDecoration: 'underline' }}>
            Page 07
          </Link>{' '}
          is where you decide who may read it.
        </Notice>
      )}
    </>
  );
}

/**
 * Anchoring.
 *
 * Optional and clearly so: the commitment exists whether or not it is on chain.
 * What the anchor adds is a place a reader can watch for revocation without
 * decrypting anything, and without asking us.
 */
function AnchorControl({
  envelope,
  record,
  chainId,
}: {
  envelope: SealedEnvelope;
  record: ReferenceRecord | null;
  chainId: number | undefined;
}): ReactNode {
  const { isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync, isPending } = useWriteContract();
  const { save } = useReferences();
  const [txHash, setTxHash] = useState<string | null>(record?.anchor?.txHash ?? null);
  const [failure, setFailure] = useState<string | null>(null);

  const anchor = useCallback(async () => {
    setFailure(null);
    try {
      if (chainId !== base.id) await switchChainAsync({ chainId: base.id });
      const hash = await writeContractAsync({
        address: ANCHOR_ADDRESS,
        abi: ANCHOR_WRITE_ABI,
        functionName: 'anchor',
        chainId: base.id,
        args: [
          envelope.referenceId as `0x${string}`,
          envelope.commitment as `0x${string}`,
          BigInt(Math.floor(Date.parse(envelope.expiresAt) / 1000)),
        ],
      });
      setTxHash(hash);
      if (record !== null) {
        save({
          ...record,
          anchor: { txHash: hash, chainId: base.id },
          envelope: {
            ...record.envelope,
            anchors: { base: { chainId: 8453, contract: ANCHOR_ADDRESS, txHash: hash } },
          },
        });
      }
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    }
  }, [chainId, envelope, record, save, switchChainAsync, writeContractAsync]);

  return (
    <>
      <SectionHead nl="Vastlegging op Base" en="Anchor on Base" />
      <p className="prose">
        Anchoring writes the commitment and the expiry to <code className="mono">{ANCHOR_ADDRESS}</code> on Base
        mainnet. It is what lets a reader see a revocation without decrypting anything and without asking us.
        Anchoring is permissionless and has no owner: a reference id belongs to whoever claims it first.
      </p>
      <div className="act">
        <button className="btn" type="button" onClick={() => void anchor()} disabled={!isConnected || isPending}>
          {isPending ? 'bevestigen…' : 'Vastleggen op Base'}
        </button>
        {txHash !== null && (
          <a className="btn plain small" href={`${EXPLORERS.base}/tx/${txHash}`} target="_blank" rel="noreferrer">
            {shortHex(txHash, 12, 8)} op basescan
          </a>
        )}
        <span className="hint">
          Costs a few thousandths of a cent at current Base gas. Skip it and the reference still works — it
          just has no public place to be revoked from.
        </span>
      </div>
      {failure !== null && (
        <Notice tone="warn" title="Niet vastgelegd / not anchored">
          {failure}
        </Notice>
      )}
    </>
  );
}
