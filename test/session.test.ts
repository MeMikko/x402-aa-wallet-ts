import { test } from "node:test";
import assert from "node:assert/strict";

import { createSpendWallet, x402Fetch } from "../src/index.js";

function mockFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url);
  }) as typeof fetch;
}

async function withGlobalFetch<T>(fetchImpl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("x402Fetch passes through a non-402 response untouched, for a SpendWallet", async () => {
  const wallet = createSpendWallet();
  await withGlobalFetch(
    mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    async () => {
      const fetchWithPayment = x402Fetch(wallet);
      const res = await fetchWithPayment("https://example.com/free");
      assert.equal(res.status, 200);
    }
  );
});

test("x402Fetch accepts a raw private key string", async () => {
  const wallet = createSpendWallet();
  await withGlobalFetch(
    mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    async () => {
      const fetchWithPayment = x402Fetch(wallet.privateKey);
      const res = await fetchWithPayment("https://example.com/free");
      assert.equal(res.status, 200);
    }
  );
});

test("x402Fetch accepts a raw LocalAccount", async () => {
  const wallet = createSpendWallet();
  await withGlobalFetch(
    mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    async () => {
      const fetchWithPayment = x402Fetch(wallet.account);
      const res = await fetchWithPayment("https://example.com/free");
      assert.equal(res.status, 200);
    }
  );
});

/**
 * Builds a synthetic v2 402 response carrying a real PAYMENT-REQUIRED
 * header — base64(JSON.stringify(paymentRequired)), exactly what
 * @x402/core's encodePaymentRequiredHeader does (confirmed by reading its
 * source; not re-exported publicly, so replicated here rather than
 * imported) — so the test exercises the exact wire format standard x402
 * endpoints use, not a v1 JSON-body shortcut.
 */
function paymentRequiredResponse(amountAtomic: string, asset?: string): Response {
  const paymentRequired = {
    x402Version: 2,
    resource: { url: "https://example.com/paid", method: "GET" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: asset ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: amountAtomic,
        payTo: "0x8520B3693a2Cf3c2bEa3a505Af3A9c1b093954c7",
        maxTimeoutSeconds: 60,
        // EIP-712 domain params for USDC's EIP-3009 transferWithAuthorization
        // signature — a real x402 server includes these; the scheme can't
        // sign without them.
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  };
  const header = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");
  return new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": header } });
}

test("x402Fetch pays a real 402 challenge and retries with a payment signature header", async () => {
  const wallet = createSpendWallet();
  let callCount = 0;
  let secondRequest: Request | null = null;

  const twoStepFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    callCount++;
    if (callCount === 1) {
      return paymentRequiredResponse("50000"); // $0.05 in USDC (6 decimals)
    }
    secondRequest = new Request(input, init);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  await withGlobalFetch(twoStepFetch, async () => {
    const fetchWithPayment = x402Fetch(wallet);
    const res = await fetchWithPayment("https://example.com/paid");
    assert.equal(res.status, 200);
  });

  assert.equal(callCount, 2, "expected an initial 402 call plus one paid retry");
  assert.ok(
    secondRequest && (secondRequest.headers.has("PAYMENT-SIGNATURE") || secondRequest.headers.has("X-PAYMENT")),
    "retry request should carry a payment signature header"
  );
});

test("x402Fetch with maxAmountUsd pays a challenge under the cap", async () => {
  const wallet = createSpendWallet();
  let callCount = 0;

  await withGlobalFetch(
    (async () => {
      callCount++;
      return callCount === 1
        ? paymentRequiredResponse("50000") // $0.05
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
    async () => {
      const fetchWithPayment = x402Fetch(wallet, { maxAmountUsd: 0.1 });
      const res = await fetchWithPayment("https://example.com/paid");
      assert.equal(res.status, 200);
    }
  );
  assert.equal(callCount, 2);
});

test("x402Fetch with maxAmountUsd refuses to pay a challenge over the cap", async () => {
  const wallet = createSpendWallet();

  await withGlobalFetch(
    (async () => paymentRequiredResponse("50000000")) as typeof fetch, // $50
    async () => {
      const fetchWithPayment = x402Fetch(wallet, { maxAmountUsd: 0.05 });
      await assert.rejects(
        () => fetchWithPayment("https://example.com/paid"),
        /exceeds the configured maxAmountUsd cap/
      );
    }
  );
});

test("x402Fetch with maxAmountUsd refuses a requirement on an unrecognized asset, even if the raw amount looks small", async () => {
  const wallet = createSpendWallet();

  // A $50 charge expressed on a hypothetical 2-decimal asset is "5000"
  // atomic units — numerically far below a $0.50 cap computed assuming
  // 6-decimal USDC (500000). Blindly comparing raw numbers would let this
  // through; verifying the asset itself must refuse it instead.
  await withGlobalFetch(
    (async () => paymentRequiredResponse("5000", "0x000000000000000000000000000000000000dd")) as typeof fetch,
    async () => {
      const fetchWithPayment = x402Fetch(wallet, { maxAmountUsd: 0.5 });
      await assert.rejects(
        () => fetchWithPayment("https://example.com/paid"),
        /exceeds the configured maxAmountUsd cap|unrecognized asset/
      );
    }
  );
});

test("x402Fetch with maxTotalUsd stops paying once the session budget is exhausted", async () => {
  const wallet = createSpendWallet();
  let paidCalls = 0;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.headers.has("PAYMENT-SIGNATURE") || req.headers.has("X-PAYMENT")) {
      paidCalls++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return paymentRequiredResponse("50000"); // $0.05 per challenge
  }) as typeof fetch;

  await withGlobalFetch(fetchImpl, async () => {
    // Budget fits exactly one $0.05 payment; the second must refuse even
    // though each individual charge is identical and "reasonable".
    const fetchWithPayment = x402Fetch(wallet, { maxTotalUsd: 0.08 });
    const first = await fetchWithPayment("https://example.com/paid");
    assert.equal(first.status, 200);
    await assert.rejects(
      () => fetchWithPayment("https://example.com/paid"),
      /maxTotalUsd budget/
    );
  });
  assert.equal(paidCalls, 1, "only the first challenge may be paid");
});

test("x402Fetch refuses an unrecognized asset even with NO cap configured", async () => {
  // The asset allowlist must not live inside the cap option: an EIP-3009
  // signature is valid for whatever token contract it names, so a capless
  // session was previously willing to sign for ANY asset a merchant put in
  // the challenge.
  const wallet = createSpendWallet();
  await withGlobalFetch(
    (async () => paymentRequiredResponse("5000", "0x000000000000000000000000000000000000dd")) as typeof fetch,
    async () => {
      const fetchWithPayment = x402Fetch(wallet);
      await assert.rejects(
        () => fetchWithPayment("https://example.com/paid"),
        /unrecognized asset/
      );
    }
  );
});

test("x402Fetch pays an unrecognized asset only with the explicit allowUnknownAssets opt-out", async () => {
  const wallet = createSpendWallet();
  let callCount = 0;
  await withGlobalFetch(
    (async () => {
      callCount++;
      return callCount === 1
        ? paymentRequiredResponse("5000", "0x00000000000000000000000000000000000000dd")
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
    async () => {
      const fetchWithPayment = x402Fetch(wallet, { allowUnknownAssets: true });
      const res = await fetchWithPayment("https://example.com/paid");
      assert.equal(res.status, 200);
    }
  );
  assert.equal(callCount, 2);
});

test("x402Fetch ignores allowUnknownAssets while a cap is set — unverified decimals defeat a USD cap", async () => {
  const wallet = createSpendWallet();
  await withGlobalFetch(
    (async () => paymentRequiredResponse("5000", "0x000000000000000000000000000000000000dd")) as typeof fetch,
    async () => {
      const fetchWithPayment = x402Fetch(wallet, { maxAmountUsd: 0.5, allowUnknownAssets: true });
      await assert.rejects(
        () => fetchWithPayment("https://example.com/paid"),
        /unrecognized asset/
      );
    }
  );
});
