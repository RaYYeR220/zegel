/**
 * Errors that carry the HTTP status a CCIP-Read client will act on.
 *
 * ERC-3668 gives the status code meaning: a 4xx aborts the whole lookup, a 5xx
 * tells the client to try the next URL in the resolver's list. So the choice of
 * code is a protocol decision, not cosmetics — a misconfigured gateway must fail
 * 5xx so a sibling can answer, and a query we can never answer must fail 4xx so
 * the client stops asking.
 */
export class GatewayError extends Error {
  readonly status: number;

  constructor(status: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GatewayError';
    this.status = status;
  }
}

/** The request could not be parsed, or names a query this gateway cannot serve. */
export function badRequest(message: string, options?: { cause?: unknown }): GatewayError {
  return new GatewayError(400, message, options);
}

/** No envelope is published for this node. Deliberately fatal — see `serveLookup`. */
export function notFound(message: string): GatewayError {
  return new GatewayError(404, message);
}

/** The envelope exists but its own expiry has passed, so no signable answer exists. */
export function gone(message: string): GatewayError {
  return new GatewayError(410, message);
}

export function unauthorized(message: string): GatewayError {
  return new GatewayError(401, message);
}

export function conflict(message: string): GatewayError {
  return new GatewayError(409, message);
}

/** Our fault, and recoverable by another gateway: 5xx sends the client to the next URL. */
export function unavailable(message: string, options?: { cause?: unknown }): GatewayError {
  return new GatewayError(503, message, options);
}
