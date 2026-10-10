import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setCopyLocale } from "../../../lib/copy";
import { EN_LOCALE, ZH_CN_LOCALE } from "../../../lib/locale";
import { ClaudeDesktopCollectionStatus } from "./ClaudeDesktopCollectionStatus.jsx";

const quotaOnly = {
  configured: true, profile_id: "default", metric: "quota-percent",
  display_name: "Personal", token_usage_status: "unavailable", token_usage: null,
  token_usage_unavailable_reason: "no-local-usage-files",
  cached_at: "2026-10-01T14:51:08.838Z", stale: true,
  five_hour: { utilization: 1 }, seven_day: { utilization: 0 },
};

describe("ClaudeDesktopCollectionStatus", () => {
  afterEach(() => setCopyLocale(EN_LOCALE));

  it("keeps quota-only desktop accounts visible without inventing tokens or cost", () => {
    render(<ClaudeDesktopCollectionStatus accounts={[quotaOnly]} />);
    expect(screen.getByText("Claude Desktop Personal")).toBeInTheDocument();
    expect(screen.getByText("Token usage unavailable")).toBeInTheDocument();
    expect(screen.getByText("No readable local token usage records")).toBeInTheDocument();
    expect(screen.queryByText(/Quota snapshot|Quota sampled|1%|0%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0 tokens|\$0/)).not.toBeInTheDocument();
  });

  it("labels observed usage as all-date local logs, not the selected period total", () => {
    render(<ClaudeDesktopCollectionStatus accounts={[{
      ...quotaOnly, metric: "token-usage", token_usage_status: "observed", token_usage_unavailable_reason: null,
      token_usage: { total_tokens: 120, input_tokens: 100, output_tokens: 20, estimated_cost_usd: 0.0006 },
    }]} />);
    expect(screen.getByRole("region", { name: "Claude Desktop local logs | all dates" })).toBeInTheDocument();
    expect(screen.getByText(/120 tokens.*API est\./)).toBeInTheDocument();
    expect(screen.queryByText("Token usage unavailable")).not.toBeInTheDocument();
  });

  it("renders Chinese unavailable status", () => {
    setCopyLocale(ZH_CN_LOCALE);
    render(<ClaudeDesktopCollectionStatus accounts={[quotaOnly]} />);
    expect(screen.getByText("Token 用量不可用")).toBeInTheDocument();
    expect(screen.getByText("没有可读取的本地 Token 用量记录")).toBeInTheDocument();
  });

  it("never exposes quota values, dates or refresh errors from live or cached payloads", () => {
    const liveAccount = {
      ...quotaOnly, source: "desktop-api", quota_refresh_status: "live", stale: false,
    };
    const { rerender } = render(<ClaudeDesktopCollectionStatus accounts={[liveAccount]} />);
    expect(screen.queryByText(/Live quota|Quota snapshot|Quota sampled|1%|0%/)).not.toBeInTheDocument();
    const failedAccount = {
      ...quotaOnly, quota_refresh_status: "failed", quota_refresh_error: "keychain-access-required",
    };
    rerender(<ClaudeDesktopCollectionStatus accounts={[failedAccount]} />);
    expect(screen.getByText("Token usage unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/keychain access|Live quota|Quota snapshot|Quota sampled|1%|0%/)).not.toBeInTheDocument();
  });

  it("does not create a desktop provider when no local profile was detected", () => {
    const { container } = render(<ClaudeDesktopCollectionStatus accounts={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
