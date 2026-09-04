'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { CreditMeter, HealthReport, ProbeRow } from '~/lib/types';

/**
 * The dependency strip and the credit meter.
 *
 * Both exist for the same reason: this product refuses to show a number it did
 * not just obtain. The strip is the live state of every upstream, refreshed by
 * asking them; the meter is Mobula's own `x-ratelimit-*` headers, forwarded from
 * whatever collection ran last. Neither is ever green because a config file said
 * so.
 */

interface MeterState {
  meter: CreditMeter | null;
  setMeter: (meter: CreditMeter | null) => void;
}

const MeterContext = createContext<MeterState>({ meter: null, setMeter: () => undefined });

export function useCreditMeter(): MeterState {
  return useContext(MeterContext);
}

export function DeskProvider({ children }: { children: ReactNode }): ReactNode {
  const [meter, setMeter] = useState<CreditMeter | null>(null);
  const value = useMemo(() => ({ meter, setMeter }), [meter]);
  return <MeterContext.Provider value={value}>{children}</MeterContext.Provider>;
}

const LABEL: Record<string, string> = {
  'mobula-demo': 'Mobula',
  'mobula-graphql': 'Mobula GraphQL',
  'mobula-prod': 'Mobula (keyed)',
  'swarm-gateway': 'Swarm gateway',
  'bee-node': 'Bee publisher',
  'bee-reader': 'Bee reader',
  'rpc-ethereum': 'Ethereum',
  'rpc-base': 'Base',
  'anchor-base': 'ZegelAnchor',
  'mobula-flaky': 'Mobula flaky routes',
};

const CLASS: Record<ProbeRow['status'], string> = {
  ok: 'ok',
  degraded: 'degraded',
  unavailable: 'unavailable',
  'not-configured': 'notconfigured',
};

export function HealthStrip(): ReactNode {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const { meter } = useCreditMeter();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      setHealth((await response.json()) as HealthReport);
    } catch {
      setHealth(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="healthstrip" aria-label="Toestand van de afhankelijkheden">
      <div className="hrow">
        <span className="htitle">Live</span>
        {health === null && <span className="hpill notconfigured">{loading ? 'probing…' : 'health unreachable'}</span>}
        {health?.probes.map((probe) => (
          <span
            key={probe.id}
            className={`hpill ${CLASS[probe.status]}`}
            title={`${probe.name} — ${probe.detail}${probe.cost === '' ? '' : ` · costs you: ${probe.cost}`}`}
          >
            <i className="dot" />
            {LABEL[probe.id] ?? probe.name}
            {probe.latencyMs !== null && <span className="ms">{probe.latencyMs}ms</span>}
          </span>
        ))}
        <CreditReadout meter={meter} />
      </div>
    </section>
  );
}

function CreditReadout({ meter }: { meter: CreditMeter | null }): ReactNode {
  if (meter === null) {
    return (
      <span className="creditmeter" title="Mobula reports credits on every response; nothing has been spent yet.">
        credits idle
      </span>
    );
  }

  const remaining = meter.latest?.remaining ?? null;
  const limit = meter.latest?.limit ?? null;
  // The keyless demo host reports a static allowance, so a bar pinned at 100%
  // would be decoration. It appears once the headroom actually moves.
  const share =
    remaining !== null && limit !== null && limit > 0 && remaining < limit ? remaining / limit : null;

  return (
    <span
      className="creditmeter"
      title={`x-ratelimit headers from ${meter.host}${meter.keyed ? ' (keyed)' : ' (no key, no signup)'}`}
    >
      {share !== null && (
        <span className="bar">
          <i className={share < 0.2 ? 'low' : ''} style={{ width: `${Math.max(2, Math.round(share * 100))}%` }} />
        </span>
      )}
      <span>
        {meter.spent} spent
        {remaining !== null && limit !== null ? ` · ${remaining}/${limit} left` : ''}
        {meter.keyed ? '' : ' · no key'}
      </span>
    </span>
  );
}
