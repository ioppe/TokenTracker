# Claude Desktop Quota Snapshots

Claude Desktop Chat does not supply the same local per-message token transcripts
as Claude Code. The limits API therefore reads desktop quota history separately
from the token collectors.

The reader discovers the default desktop profile, numbered `.claudeN` profiles
used by CodexQuotaViewer, and explicitly configured desktop profiles. It reads
only `plan-usage-history.json` version 2, plus optional CodexQuotaViewer profile
names and the saved profile selection. No browser cookies or desktop login
credentials are read, and no desktop request is intercepted.

For each profile, the newest non-future observation supplies its five-hour
(`u.fh`) and seven-day (`u.sd`) percentages. The reader never adds percentages,
combines accounts, or fills a missing window from a previous login. Missing,
malformed, oversized, or symlinked history files are skipped independently.

The local limits response exposes these observations in
`claude.desktop_accounts`, with `metric: "quota-percent"`,
`source: "local-history"`, the original `cached_at` sample time, and a `stale`
flag after ten minutes. Organization identifiers and absolute profile paths are
not returned. `is_selected` describes CodexQuotaViewer's saved selection, not a
verified running process.

Dashboard and macOS limits panels show separate **Quota snapshot** rows under
the Claude visibility setting. Claude Code's authenticated live quota remains
unchanged. Historical observations contain no reset time, so they do not drive
pace projections, token totals, costs, predictive alerts, or reset notifications.

Refreshing TokenTracker rereads the file after its ordinary limits cache expires
(or on an explicit refresh); Claude Desktop must update its own history to
produce a new sample. A source checkout change does not replace an already
installed app's bundled runtime: rebuild the desktop package to ship this reader.
