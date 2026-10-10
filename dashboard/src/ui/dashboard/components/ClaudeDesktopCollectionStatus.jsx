import React from "react";
import { copy } from "../../../lib/copy";
import { desktopAccountName, desktopTokenUsageText } from "../../../lib/claude-desktop-display.js";
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
            </div>
          </div>
        );
      })}
    </section>
  );
}
