import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";

/**
 * Local, non-custodial EOA generation for x402 payments.
 *
 * Why this exists: x402's "exact" EVM scheme settles payments via EIP-3009
 * transferWithAuthorization, which recovers the payer's address from a
 * secp256k1 (ECDSA) signature. An ERC-4337 smart-contract wallet's owner
 * key is often a P256/WebAuthn passkey (a different curve entirely — not
 * ecrecover-compatible), or even when it is a secp256k1 key, the recovered
 * address is the owner's, not the smart wallet's own address, which the
 * facilitator's from-address check rejects. Full ERC-1271/ERC-6492
 * smart-wallet support is an open, unshipped feature across today's x402
 * facilitators — see https://github.com/coinbase/x402/issues/639.
 *
 * The fix isn't to route your AA wallet's signature through x402 directly
 * — it's to give your agent a small, DEDICATED EOA it funds itself (from
 * its own smart wallet, via its own existing send/transfer capability)
 * purely for x402 spending, separate from whatever wallet it uses for
 * everything else.
 *
 * Non-custodial, by construction: this module never transmits, logs, or
 * persists a private key anywhere. Key generation happens entirely inside
 * your own process via viem's `generatePrivateKey`; the private key is
 * returned to YOU and exists only in your process's memory unless you
 * choose to store it. This package has no visibility into it, ever.
 */

export interface SpendWallet {
  address: `0x${string}`;
  privateKey: `0x${string}`;
  /** Ready to pass straight into {@link x402Fetch}. */
  account: LocalAccount;
}

/**
 * Builds a SpendWallet with `privateKey` defined as a non-enumerable
 * property — it still reads exactly like a plain field (`wallet.privateKey`
 * works), but `console.log(wallet)`, `JSON.stringify(wallet)`, and most
 * structured loggers/error serializers/Sentry breadcrumbs only walk
 * ENUMERABLE own properties, so none of them print the key by accident.
 * `address`/`account` stay plain enumerable fields — nothing sensitive
 * about those.
 */
function buildSpendWallet(address: `0x${string}`, privateKey: `0x${string}`, account: LocalAccount): SpendWallet {
  return Object.defineProperties(
    { address, account } as SpendWallet,
    { privateKey: { value: privateKey, enumerable: false, writable: false, configurable: false } }
  );
}

/**
 * Generate a new secp256k1 EOA locally — entirely in this process, never
 * transmitted anywhere. Fund the returned `address` with USDC on Base from
 * your agent's own smart wallet (using its own existing send/transfer
 * capability — this library never moves funds itself), then use
 * `privateKey` (or `account`) with `x402Fetch`.
 */
export function createSpendWallet(): SpendWallet {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return buildSpendWallet(account.address, privateKey, account);
}

/**
 * Rehydrate a `SpendWallet` from a private key you already generated and
 * stored yourself (e.g. loaded from an env var on agent restart) — the
 * counterpart to `createSpendWallet` for a wallet you've already funded
 * and don't want to regenerate.
 */
export function spendWalletFromPrivateKey(privateKey: `0x${string}`): SpendWallet {
  const account = privateKeyToAccount(privateKey);
  return buildSpendWallet(account.address, privateKey, account);
}
