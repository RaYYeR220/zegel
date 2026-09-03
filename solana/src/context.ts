/** The issuer handle every write path takes, kept separate so the action modules do not import each other. */

import type { KeyPairSigner } from '@solana/kit';
import type { IssuerAddresses } from './pdas.ts';
import type { SendOptions, SolanaRpc } from './rpc.ts';

export interface ZegelIssuerContext {
  rpcUrl: string;
  rpc: SolanaRpc;
  /** Credential authority and authorized signer. Also the fee payer. */
  authority: KeyPairSigner;
  addresses: IssuerAddresses;
  sendOptions: SendOptions;
}
