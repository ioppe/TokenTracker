// These providers currently expose quota values that cannot be verified live
// for the account types used by this fork. Keep their collectors intact, but
// suppress the values in the limits UI until a reliable live source exists.
export const HIDDEN_UNVERIFIED_QUOTA_PROVIDERS = Object.freeze(["claude", "codex"]);
