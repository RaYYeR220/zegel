'use client';

import { useCallback, useEffect, useState } from 'react';

import type { ReferenceRecord } from './types';

/**
 * Where an issued reference lives.
 *
 * In the issuer's own browser, and nowhere else. There is no filesystem on the
 * deployment target and no database behind this app, which is not a shortcut: the
 * ACT history address cannot be recovered from Swarm, from the reference or from
 * the publisher key, so it belongs with the person who would lose access if it
 * went missing. Every server route is stateless and takes the coordinates back as
 * an argument.
 *
 * The consequence is stated on the page rather than hidden: clear this browser
 * and the reference is unreachable, exactly as the seal layer's README warns.
 */
const KEY = 'zegel.references.v1';

function read(): ReferenceRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ReferenceRecord[]) : [];
  } catch {
    return [];
  }
}

function write(records: readonly ReferenceRecord[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(records));
    window.dispatchEvent(new Event(KEY));
  } catch {
    /* a browser with storage disabled still gets a working session, just not a durable one */
  }
}

export function useReferences(): {
  records: readonly ReferenceRecord[];
  ready: boolean;
  save: (record: ReferenceRecord) => void;
  remove: (referenceId: string) => void;
} {
  const [records, setRecords] = useState<readonly ReferenceRecord[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const sync = (): void => {
      setRecords(read());
    };
    sync();
    setReady(true);
    window.addEventListener(KEY, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(KEY, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const save = useCallback((record: ReferenceRecord) => {
    const current = read().filter((existing) => existing.referenceId !== record.referenceId);
    write([record, ...current]);
  }, []);

  const remove = useCallback((referenceId: string) => {
    write(read().filter((existing) => existing.referenceId !== referenceId));
  }, []);

  return { records, ready, save, remove };
}
