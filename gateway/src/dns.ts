import { hexToBytes, type Hex } from 'viem';

import { badRequest } from './errors.ts';

/** DNS labels are length-prefixed by a single byte, so this is a hard format limit. */
const MAX_LABEL_LENGTH = 63;

/**
 * Decodes an ENSIP-10 DNS-wire-format name back to its dotted form.
 *
 * The gateway needs the name for one reason only: to check that the `node` inside
 * the inner `data()` call really is the namehash of the name the client asked
 * about. Without that check a caller could ask for `alice.eth` and have us sign a
 * response carrying `bob.eth`'s envelope — the signature would bind the calldata
 * faithfully, and the client would still be misled.
 */
export function decodeDnsName(encoded: Hex): string {
  const bytes = hexToBytes(encoded);
  const labels: string[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });

  let offset = 0;
  for (;;) {
    const length = bytes[offset];
    if (length === undefined) throw badRequest('DNS-encoded name is not terminated');
    offset += 1;

    if (length === 0) break;
    if (length > MAX_LABEL_LENGTH) {
      throw badRequest(`DNS label at offset ${offset - 1} is ${length} bytes, over the 63-byte limit`);
    }
    if (offset + length > bytes.length) {
      throw badRequest('DNS-encoded name is truncated mid-label');
    }

    try {
      labels.push(decoder.decode(bytes.subarray(offset, offset + length)));
    } catch (cause) {
      throw badRequest('DNS label is not valid UTF-8', { cause });
    }
    offset += length;
  }

  if (offset !== bytes.length) {
    throw badRequest('DNS-encoded name has trailing bytes after the root label');
  }

  return labels.join('.');
}
