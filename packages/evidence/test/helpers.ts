import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { EvidenceBundle } from '../src/sdk.js';

const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));

/**
 * Fixtures are real recorded responses from `demo-api.mobula.io`, not invented
 * JSON. Each read returns a fresh deep copy so a test that tampers with a bundle
 * cannot leak into the next one.
 */
export function loadBundle(name: 'bundle-evm' | 'bundle-solana'): EvidenceBundle {
  return JSON.parse(readFileSync(`${dir}${name}.json`, 'utf8')) as EvidenceBundle;
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const BUNDLE_NAMES = ['bundle-evm', 'bundle-solana'] as const;
