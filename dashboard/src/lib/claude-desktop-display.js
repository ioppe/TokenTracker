import { copy } from "./copy";
import { formatCompactNumber } from "./format";

export function desktopAccountName(account) {
  if (account.display_name) return account.display_name;
  if (account.profile_id === "default") return copy("limits.claude_desktop.default_account");
  if (account.profile_number != null) {
    return copy("limits.claude_desktop.numbered_account", { number: account.profile_number });
  }
  return account.profile_name || copy("limits.claude_desktop.default_account");
}

export function hasDesktopQuota(account) {
  return account?.metric === "quota-percent" && Boolean(account.five_hour || account.seven_day);
}

export function hasDesktopTokenData(account) {
  return account?.metric === "token-usage" || Boolean(account?.token_usage)
    || account?.token_usage_status === "partial" || account?.token_usage_status === "unavailable";
}

export function desktopQuotaLabel(account) {
  return copy(account?.source === "desktop-api" && account?.quota_refresh_status === "live"
    ? "limits.claude_desktop.live" : "limits.claude_desktop.history");
}

export function desktopQuotaRefreshText(account) {
  const keys = {
    "keychain-access-required": "limits.claude_desktop.keychain_required",
    "desktop-sign-in-required": "limits.claude_desktop.sign_in_required",
    "desktop-access-denied": "limits.claude_desktop.access_denied",
    "desktop-rate-limited": "limits.claude_desktop.rate_limited",
    "desktop-request-timeout": "limits.claude_desktop.request_timeout",
    "desktop-api-unavailable": "limits.claude_desktop.api_unavailable",
    "desktop-quota-unavailable": "limits.claude_desktop.api_unavailable",
  };
  return keys[account?.quota_refresh_error] ? copy(keys[account.quota_refresh_error]) : null;
}

export function desktopTokenUsageText(account) {
  if (account?.token_usage_status === "unavailable") return copy("limits.claude_desktop.token_usage_unavailable");
  if (account?.token_usage_status === "partial" && !account?.token_usage) {
    return copy("limits.claude_desktop.token_usage_partial");
  }
  const usage = account?.token_usage;
  if (!usage) return null;
  const cost = usage.estimated_cost_usd;
  const formattedCost = cost == null || !Number.isFinite(Number(cost)) ? null
    : new Intl.NumberFormat(undefined, {
      style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 6,
    }).format(Number(cost));
  const costSuffix = formattedCost
    ? copy("limits.claude_desktop.token_usage_api_estimate", { cost: formattedCost }) : "";
  const statusSuffix = account?.token_usage_status === "partial"
    ? copy("limits.claude_desktop.token_usage_partial") : "";
  return copy("limits.claude_desktop.token_usage", {
    total: formatCompactNumber(usage.total_tokens), input: formatCompactNumber(usage.input_tokens),
    output: formatCompactNumber(usage.output_tokens), cost_suffix: `${costSuffix}${statusSuffix}`,
  });
}
