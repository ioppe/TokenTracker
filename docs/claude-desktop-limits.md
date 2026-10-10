# Claude Desktop Collection

The collector discovers the default Claude Desktop profile and CodexQuotaViewer's
numbered `.claudeN` profiles. The launcher only chooses the profile; it does not
fetch Claude's quota. `plan-usage-history.json` is a fallback, not a live feed.

## Live Quota On macOS

The limits poll reads only Claude Desktop's own `sessionKey`, `lastActiveOrg` and
optional `cf_clearance` cookies, plus its existing encrypted OAuth cache. Electron
v10 values are decrypted with the **Claude Safe Storage / Claude Key** keychain
item. macOS may require the user to authorize this access. Keys and credentials
stay in memory; they are never returned in the local API, logged, or written to
TokenTracker's usage cache. No browser profile is read and no desktop request is
intercepted. The collector does not rotate Desktop's OAuth refresh tokens or
modify its cookies/configuration.

A current, identity-matched OAuth token uses
`https://api.anthropic.com/api/oauth/usage`; otherwise the signed-in Desktop
session uses `https://claude.ai/api/organizations/{org}/usage`. Redirects are
rejected. Each request has a deadline and HTTP 429 imposes a per-account cooldown
which manual refresh cannot bypass. Quota is cached for three minutes, invalidated
at reset boundaries, and explicitly refreshed by the limits refresh action.
Account changes invalidate cached quota. Concurrent polls share one request.
History fallbacks are restricted to the active organization when its identity is
known. A connection failure without any observed sample has no capture timestamp.

Successful results carry `source: "desktop-api"`, authoritative reset times and
the actual sample time. Failure preserves the last-good timestamp and marks it
stale, or falls back to the original history snapshot with no invented reset.
`quota_refresh_error` distinguishes keychain access, sign-in, denied requests,
timeouts and rate limits. The dashboard and menu bar distinguish **Live quota**
from **Quota snapshot**. A failed refresh never advances a historic capture date.

Set `TOKENTRACKER_CLAUDE_DESKTOP_LIVE=0` to disable credential access and network
queries. Other operating systems currently retain the history-only fallback.

## Tokens

Ordinary subscription Chat without structured usage counters has no measured token
count or API cost. Quota percentages are never converted to tokens. Counts are
available only when the local profile actually contains supported telemetry:
Code/Cowork/Agent JSONL with explicit usage fields, or Desktop's v1
`usage-ledger/YYYY-MM-DD[.N].ndjson` files with per-model token deltas. Some Desktop
configurations do not write this ledger; its absence is not zero usage. A VM disk
or conversation cache alone is not a supported counter source.

The scanner deduplicates streaming/copy records and differences explicit cumulative
session counters. It returns all-date local counts, per-model API-equivalent cost
estimates and scan coverage separately from the dashboard's selected-period totals.
It never retains prompts, messages, tools or raw session identifiers. No historical
Chat count is invented when the required telemetry is absent.

Native apps bundle their own runtime. Rebuild and install the suffixed custom
release to deploy collector changes; editing the source checkout is not sufficient.
