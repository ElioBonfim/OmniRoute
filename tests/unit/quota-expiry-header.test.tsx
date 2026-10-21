import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import QuotaCardHeader from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/parts/QuotaCardHeader.tsx";
function render(expiresAt: string | null, tokenExpiresAt: string) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={{
        usage: {
          tokenExpiresIn: "Token expires in {time}",
          tokenExpired: "Token expired",
          deactivateAccount: "Deactivate",
          activateAccount: "Activate",
          noPlanFromProvider: "No plan",
          rawPlanWithValue: "Plan {plan}",
          staleQuotaTooltip: "Stale quota",
        },
      }}
    >
      <QuotaCardHeader
        connection={{
          provider: "claude",
          authType: "oauth",
          name: "Regression",
          expiresAt,
          tokenExpiresAt,
          isActive: true,
        }}
        providerLabel="Claude"
        cardStatus="ok"
        tierMeta={{ key: "max", label: "Max", variant: "success" }}
        resolvedPlan={null}
        emailsVisible={true}
        hasStaleData={false}
        onToggleActive={() => {}}
        togglingActive={false}
      />
    </NextIntlClientProvider>
  );
}
test("quota renders current OAuth expiry rather than a stale alias", () => {
  const html = render(new Date(Date.now() + 3600000).toISOString(), "2020-01-01T00:00:00Z");
  assert.match(html, /Token expires in/);
  assert.doesNotMatch(html, /Token expired/);
});
test("quota supports legacy rows with only tokenExpiresAt", () => {
  assert.match(render(null, new Date(Date.now() + 3600000).toISOString()), /Token expires in/);
});
test("quota still displays an actually expired token", () => {
  assert.match(render("2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z"), /Token expired/);
});
