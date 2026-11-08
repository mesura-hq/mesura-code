import { matchPaymentDomain } from "@t3tools/shared/paymentDomains";
import { constVoid } from "effect/Function";
import type { Page } from "playwright-core";

export interface PaymentNavigationBlock {
  readonly domain: string;
  readonly url: string;
}

export const paymentNavigationBlockedMessage = (domain: string) =>
  `${domain} is a payment site, so agents cannot open it: agents never buy, pay or confirm a purchase. If a person must act there, ask the operator to take control of this tab (preview_request_takeover).`;

/** The listed payment domain a document URL belongs to; unparsable URLs belong to none. */
export const paymentDomainOfUrl = (url: string, paymentDomains: ReadonlyArray<string>) => {
  try {
    return matchPaymentDomain(new URL(url).hostname, paymentDomains);
  } catch {
    return undefined;
  }
};

/**
 * Fails document requests, in any frame, to payment domains while no human holds the tab.
 * It uses its own CDP session: Chrome offers a paused request to the newest Fetch client
 * first, so a refusal here never reaches the PDF interception, which continues the rest.
 */
export async function installPaymentNavigationGuard(
  page: Page,
  options: {
    readonly agentDrives: () => boolean;
    readonly paymentDomains: () => Promise<ReadonlyArray<string>>;
    readonly onBlocked: (block: PaymentNavigationBlock) => void;
  },
) {
  const cdp = await page.context().newCDPSession(page);
  cdp.on("Fetch.requestPaused", ({ requestId, request }) => {
    const proceed = () => cdp.send("Fetch.continueRequest", { requestId });
    void (async () => {
      if (!options.agentDrives()) return proceed();
      const domain = paymentDomainOfUrl(request.url, await options.paymentDomains());
      if (domain === undefined) return proceed();
      options.onBlocked({ domain, url: request.url });
      await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      // Fail closed: an unanswered request would hang the tab, an unchecked one could reach a payment.
    })().catch(() =>
      cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(constVoid),
    );
  });
  // Sub-resources never pause, so pages keep their normal loading cost.
  await cdp.send("Fetch.enable", {
    patterns: [{ resourceType: "Document", requestStage: "Request" }],
  });
}
