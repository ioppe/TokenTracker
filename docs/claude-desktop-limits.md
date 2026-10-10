# Claude Desktop Local-Log Feature Removed

The custom-collectors channel no longer shows Claude Desktop local-log account
status on the usage page, limits page, or native menu. Cached `desktop_accounts`
payloads are ignored. The dedicated account usage, usage-ledger, history quota,
and live quota collectors have been removed, along with their credential reads
and network requests.

Ordinary Claude Code JSONL collection is unchanged. Supported transcripts in
desktop profile roots still contribute measured tokens to the standard Claude
usage totals, without a separate account diagnostic panel. Existing token
history, cost estimates, and provider usage shares are retained. Missing Chat
telemetry is not converted into estimated tokens.

The release validator rejects stale local-log modules or dashboard assets in
the embedded payload. Install the rebuilt suffixed custom release to apply the
removal to the native app.
