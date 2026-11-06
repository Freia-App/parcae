/**
 * Client-side auth adapter interface.
 *
 * The adapter is the source of truth for *the current bearer token*.
 * Parcae calls `getToken()` from the transport's hello/refresh
 * handshake — once before the initial connect and once per
 * reconnect or token rotation.
 *
 * The adapter publishes token changes via `onChange`. Token rotations
 * trigger `client.refreshSession()`; sign-out triggers
 * `client.terminateSession()`. The transport does *not* infer auth
 * state from socket lifecycle events.
 */

export interface TokenRequest {
  fresh?: boolean;
}

export interface AuthClientAdapter {
  /** Called once by ParcaeProvider before the transport is built. */
  init(baseUrl: string): void;

  /**
   * Resolve the current bearer token. `null` = anonymous session.
   *
   * `fresh` asks for a newly issued token rather than a cached one. The
   * transport sets it only to renew, where the claims cannot change, so a
   * provider that announces each new token through `onChange` cannot
   * restart a handshake that is still waiting for its ack.
   */
  getToken(options?: TokenRequest): Promise<string | null>;

  /**
   * Subscribe to token changes. Fired on sign-in (non-null token),
   * sign-out (null), and rotation (different non-null token).
   * Returns unsubscribe.
   */
  onChange(callback: (token: string | null) => void): () => void;
}
