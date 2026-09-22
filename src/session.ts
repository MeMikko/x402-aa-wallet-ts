import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import type { Network, PaymentRequirements } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { LocalAccount } from "viem";

import { spendWalletFromPrivateKey, type SpendWallet } from "./wallet.js";

/** Base mainnet, CAIP-2 form — the default network, and the only one
 * registered unless `options.network` overrides it. */
export const NETWORK: Network = "eip155:8453";

/** USDC's own decimals on every chain x402 currently settles on (Base
 * included) — used to convert a human `maxAmountUsd` into the atomic
 * units `PaymentRequirements.amount` is expressed in. */
const USDC_DECIMALS = 6;

/**
 * Circle's own native USDC contract addresses, keyed by CAIP-2 network —
 * every one is 6 decimals (Circle mandates this across all its official
 * deployments, unlike third-party bridged/wrapped variants elsewhere).
 * `PaymentRequirements.asset` is just an address; nothing about the x402
 * protocol guarantees it points at one of these. `maxAmountUsdPolicy`
 * only applies the USDC_DECIMALS-based cap to a requirement whose asset
 * matches an entry here — anything else is excluded rather than
 * evaluated with a guessed decimal count. Getting decimals wrong in
 * either direction is bad, but guessing UNDER the real value (e.g.
 * treating an 18-decimal asset's raw amount as if it were 6-decimal)
 * makes a genuinely large charge look small enough to pass the cap —
 * that failure mode is worse than refusing to pay an asset this policy
 * can't verify, so unknown assets fail closed.
 */
const KNOWN_USDC_ADDRESSES: Partial<Record<Network, string>> = {
  "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // Base mainnet
  "eip155:84532": "0x036cbd53842c5426634e7929541ec2318f3dcf7e", // Base Sepolia
};

function isSpendWallet(w: SpendWallet | LocalAccount | `0x${string}`): w is SpendWallet {
  return typeof w === "object" && "account" in w;
}

export interface X402FetchOptions {
  /**
   * Refuse to pay any single 402 challenge above this USD amount. Without
   * this, `x402Fetch` pays whatever the server's 402 response asks for —
   * a misbehaving or compromised merchant returning e.g.
   * `amount: "50000000"` ($50) instead of the expected $0.05 gets paid in
   * full, silently. Recommended for any caller giving an agent autonomous
   * spending — this is a real enforcement boundary (a `PaymentPolicy`
   * registered on the underlying `x402Client`), not just a suggestion in
   * a docstring: a requirement over the cap is filtered out before
   * signing, and if that leaves nothing payable, the call throws instead
   * of silently proceeding.
   *
   * Note this is PER CHALLENGE: a merchant charging exactly at the cap on
   * every request still drains `cap × N` over N requests — which is
   * precisely how an autonomous retry loop gets bled. Pair it with
   * {@link maxTotalUsd} to bound the whole session.
   */
  maxAmountUsd?: number;
  /**
   * Cumulative budget for everything this `x402Fetch` wrapper authorizes,
   * in USD. Once authorized payments reach this budget, further 402
   * challenges throw instead of paying — the backstop `maxAmountUsd`
   * alone cannot provide against drain-by-repetition.
   *
   * Accounting is at AUTHORIZATION time, deliberately conservative: the
   * amount is counted the moment this policy approves a requirement for
   * signing, not when settlement is confirmed. A payment that later fails
   * still consumes budget (the signature left the process — from a
   * spend-control standpoint the money must be presumed gone), and the
   * upstream client re-invoking the policy for the same challenge counts
   * again. The ledger lives inside this wrapper instance; build a new
   * `x402Fetch` to start a fresh budget.
   */
  maxTotalUsd?: number;
  /**
   * By default every payment requirement must name a known Circle USDC
   * deployment (see `KNOWN_USDC_ADDRESSES`) before this library will sign
   * anything — EVEN when no cap is set. An EIP-3009 authorization is
   * valid for whatever token contract it names, so without this check a
   * merchant could induce a signature moving ANY EIP-3009 token the EOA
   * happens to hold. Set `true` to sign for unrecognized assets anyway —
   * only sensible when the wallet holds nothing but funds you are willing
   * to lose, and never honored while `maxAmountUsd`/`maxTotalUsd` is set
   * (an asset with unverified decimals cannot be measured against a USD
   * cap; guessing UNDER the real decimals is exactly the historical
   * bypass, see `KNOWN_USDC_ADDRESSES`).
   */
  allowUnknownAssets?: boolean;
  /** Override the network this wallet pays on — CAIP-2 form, e.g.
   * `"eip155:8453"` (Base) or `"solana:mainnet"`. Defaults to `NETWORK`
   * (Base mainnet). Only Base/EVM "exact"-scheme payments are supported
   * by this library today regardless of the value passed here — see the
   * README before assuming Solana works out of the box. */
  network?: Network;
}

function usdToAtomic(usd: number): bigint {
  return BigInt(Math.round(usd * 10 ** USDC_DECIMALS));
}

function isVerifiedUsdc(r: PaymentRequirements): boolean {
  const knownUsdc = KNOWN_USDC_ADDRESSES[r.network];
  if (!knownUsdc || r.asset.toLowerCase() !== knownUsdc) return false;
  // A negative amount is malformed. uint256 encoding would reject it
  // downstream anyway, but a spend policy should never call it payable.
  return BigInt(r.amount) >= 0n;
}

function describe(requirements: PaymentRequirements[]): string {
  return requirements
    .map((r) => `${r.amount} atomic units of ${r.asset} on ${r.network}`)
    .join(", ");
}

function paymentPolicy(options: { maxAmountUsd?: number; maxTotalUsd?: number }) {
  const perCallCapAtomic =
    options.maxAmountUsd !== undefined ? usdToAtomic(options.maxAmountUsd) : undefined;
  const totalCapAtomic =
    options.maxTotalUsd !== undefined ? usdToAtomic(options.maxTotalUsd) : undefined;
  // Cumulative authorization ledger for this wrapper instance. Counted at
  // approval time (see X402FetchOptions.maxTotalUsd for why), so it only
  // ever over-counts — never under.
  let authorizedAtomic = 0n;

  return (_x402Version: number, requirements: PaymentRequirements[]): PaymentRequirements[] => {
    if (requirements.length === 0) return requirements;

    const verified = requirements.filter(isVerifiedUsdc);
    if (verified.length === 0) {
      throw new Error(
        `x402Fetch: none of the payment options (${describe(requirements)}) is on a recognized Circle USDC deployment (unrecognized asset, decimals not verified) — refusing to sign. ` +
          "An unverified asset cannot be measured against a USD cap, and an EIP-3009 signature is valid for whatever token it names. " +
          "Pass allowUnknownAssets: true (with no maxAmountUsd/maxTotalUsd) only if this wallet holds nothing you are not willing to lose."
      );
    }

    const underPerCall =
      perCallCapAtomic === undefined
        ? verified
        : verified.filter((r) => BigInt(r.amount) <= perCallCapAtomic);
    if (underPerCall.length === 0) {
      throw new Error(
        `x402Fetch: every payment option (${describe(verified)}) exceeds the configured maxAmountUsd cap of $${options.maxAmountUsd} — refusing to pay. ` +
          "Raise maxAmountUsd if this charge is expected, or investigate why the server is asking for more than usual."
      );
    }

    if (totalCapAtomic === undefined) return underPerCall;

    const withinBudget = underPerCall.filter(
      (r) => authorizedAtomic + BigInt(r.amount) <= totalCapAtomic
    );
    if (withinBudget.length === 0) {
      const authorizedUsd = Number(authorizedAtomic) / 10 ** USDC_DECIMALS;
      throw new Error(
        `x402Fetch: paying any offered option (${describe(underPerCall)}) would push this session past its maxTotalUsd budget of $${options.maxTotalUsd} ` +
          `(already authorized $${authorizedUsd}) — refusing to pay. ` +
          "Build a new x402Fetch to start a fresh budget if this spending is intended."
      );
    }
    // The client settles ONE of the requirements this policy returns. To
    // keep the ledger honest, return exactly one — the cheapest — and
    // count it as authorized now.
    const cheapest = withinBudget.reduce((a, b) =>
      BigInt(a.amount) <= BigInt(b.amount) ? a : b
    );
    authorizedAtomic += BigInt(cheapest.amount);
    return [cheapest];
  };
}

/**
 * A `fetch`-compatible function that transparently pays any HTTP 402 x402
 * challenge it hits, signing with `wallet` — works against ANY x402
 * "exact"-scheme merchant on Base mainnet.
 *
 * @param wallet a `SpendWallet` (from `createSpendWallet`), a raw viem
 *   `LocalAccount`, or a private key hex string. Every payment this makes
 *   is real USDC on Base mainnet — only fund this wallet with what you're
 *   willing to spend, and never reuse an EOA that also holds other funds
 *   you care about.
 * @param options see {@link X402FetchOptions}. `maxAmountUsd` is strongly
 *   recommended for autonomous/agent use.
 */
export function x402Fetch(
  wallet: SpendWallet | LocalAccount | `0x${string}`,
  options?: X402FetchOptions
): typeof fetch {
  const account: LocalAccount =
    typeof wallet === "string"
      ? spendWalletFromPrivateKey(wallet).account
      : isSpendWallet(wallet)
        ? wallet.account
        : wallet;

  const client = new x402Client().register(options?.network ?? NETWORK, new ExactEvmScheme(account));
  // The asset-verification policy is ALWAYS on unless the caller both sets
  // no cap and explicitly opts into unknown assets. With a cap set,
  // allowUnknownAssets is deliberately ignored: an asset with unverified
  // decimals cannot be measured against a USD cap.
  const hasCap = options?.maxAmountUsd !== undefined || options?.maxTotalUsd !== undefined;
  if (hasCap || !options?.allowUnknownAssets) {
    client.registerPolicy(
      paymentPolicy({ maxAmountUsd: options?.maxAmountUsd, maxTotalUsd: options?.maxTotalUsd })
    );
  }
  return wrapFetchWithPayment(fetch, client);
}
