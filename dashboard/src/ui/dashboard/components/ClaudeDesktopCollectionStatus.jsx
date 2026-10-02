import React from "react";
import { copy, getCopyLocale } from "../../../lib/copy";
import { desktopAccountName, desktopTokenUsageText, hasDesktopQuota } from "../../../lib/claude-desktop-display.js";
import { ProviderIcon } from "./ProviderIcon.jsx";

export function ClaudeDesktopCollectionStatus({ accounts = [] }) {
  const detected = accounts.filter((account) => { return account?.configured; });
  if (detected.length === 0) return null;
  return (
    <section aria-label={copy("usage.claude_desktop.local_scope")} className="border-t border-oai-gray-200 dark:border-oai-gray-800 pt-4 space-y-3">
      <h3 className="text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">
        {copy("usage.claude_desktop.local_scope")}
      </h3>
      {detected.map((account) => {
        const captured = Date.parse(account.cached_at);
        const sampledAt = Number.isFinite(captured) ? new Intl.DateTimeFormat(getCopyLocale(), {
          month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
        }).format(new Date(captured)) : null;
        const quota = hasDesktopQuota(account) ? [
          ["limits.label.claude_5h", account.five_hour?.utilization],
          ["limits.label.claude_7d", account.seven_day?.utilization],
        ].filter(([, value]) => typeof value === "number").map(([key, value]) =>
          copy("usage.claude_desktop.quota_window", { window: copy(key), percent: value }),
        ).join(" / ") : null;
        return (
          <div key={account.profile_id} className="flex items-start gap-2 text-xs min-w-0">
            <ProviderIcon provider="claude" size={16} className="shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1 space-y-1 break-words">
              <div className="font-medium text-oai-black dark:text-oai-white">
                {copy("limits.claude_desktop.title", { account: desktopAccountName(account) })}
              </div>
              <p className="tabular-nums text-oai-gray-600 dark:text-oai-gray-300">
                {desktopTokenUsageText(account) || copy("limits.claude_desktop.token_usage_unavailable")}
              </p>
              {account.token_usage_unavailable_reason === "no-local-usage-files" ? (
                <p className="text-oai-gray-500 dark:text-oai-gray-400">{copy("usage.claude_desktop.no_local_usage")}</p>
              ) : null}
              {quota ? (
                <p className="tabular-nums text-oai-gray-500 dark:text-oai-gray-400">
                  {copy("limits.claude_desktop.history")}{": "}{quota}
                  {sampledAt ? <span>{" | "}{copy("limits.claude_desktop.sampled_at", { time: sampledAt })}</span> : null}
                  {account.stale ? <span>{" | "}{copy("limits.provenance.stale")}</span> : null}
                </p>
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}
