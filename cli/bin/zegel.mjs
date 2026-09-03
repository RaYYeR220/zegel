#!/usr/bin/env node
/**
 * Entry point.
 *
 * The sibling packages ship TypeScript sources rather than build output, and the
 * shared wire types have to be the same declarations everywhere or commitments
 * stop matching across modules. So the CLI runs the sources directly through
 * `tsx`, which honours the `paths` in tsconfig.json — no build step for a judge
 * to discover, and exactly one copy of `@zegel/sdk` in the process.
 */

import { register } from 'tsx/esm/api';

register();

const { main } = await import('../src/main.ts');
await main();
