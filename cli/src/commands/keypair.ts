/**
 * `zegel keypair` — a throwaway grantee identity, so grant and revoke can be
 * demonstrated by someone who has no wallet in front of them.
 *
 * A real verifier generates this on their own machine and never sends the private
 * half anywhere; ACT keys on the public key, and the private key is what makes a
 * grant mean something. This command exists because a demo that cannot produce a
 * grantee cannot demonstrate revocation, and revocation is the point.
 */

import type { Output } from '../core/output.js';
import { banner, bullet, field, section } from '../render/layout.js';

export async function keypair(out: Output): Promise<number> {
  const seal = await import('@zegel/seal');

  const privateKey = new Uint8Array(32);
  globalThis.crypto.getRandomValues(privateKey);
  const privateHex = [...privateKey].map((b) => b.toString(16).padStart(2, '0')).join('');
  const publicKey = seal.granteeFromPrivateKey(privateKey);
  const address = seal.granteeAddress(publicKey);

  if (out.json) {
    out.emit({
      command: 'keypair',
      publicKey,
      address,
      privateKey: privateHex,
      note: 'demonstration key. A real verifier generates their own and never shares the private half.',
    });
    return 0;
  }

  const theme = out.theme;
  out.lines(banner(theme, 'zegel keypair', 'a grantee identity for demonstrating grant and revoke'));
  out.lines(section(theme, 'the identity'));
  out.line(field(theme, 'public key', theme.bold(publicKey)));
  out.line(field(theme, 'address', address));
  out.line(field(theme, 'private key', theme.warn(privateHex)));
  out.line();
  out.lines([
    bullet(theme, 'The public key is what you pass to `zegel grant` and `zegel revoke`.'),
    bullet(
      theme,
      'The address is shown for recognition only. ACT keys on the public key: an address is a hash and cannot take part in the key exchange.',
    ),
    bullet(
      theme,
      theme.warn(
        'This key was generated here and printed to your terminal, so treat it as compromised. A real verifier generates their own and never sends the private half to anyone.',
      ),
    ),
  ]);
  out.line();

  return 0;
}
