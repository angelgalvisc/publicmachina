/**
 * cast-enrichment.test.ts — Tests for cast enrichment (Phase 7)
 */

import { describe, it, expect } from "vitest";
import {
  communityFollowProbability,
  communitySentimentBias,
} from "../src/cast-enrichment.js";
import type { EnrichedSourceSummary } from "../src/cast-design.js";
import type { CommunityProposal } from "../src/design.js";

// ═══════════════════════════════════════════════════════
// EnrichedSourceSummary type validation
// ═══════════════════════════════════════════════════════

describe("EnrichedSourceSummary", () => {
  it("type accepts all required fields", () => {
    const summary: EnrichedSourceSummary = {
      title: "SEC Joint AI-Crypto Framework",
      sourceUrl: "https://sec.gov/framework.pdf",
      summary: "The SEC published a joint framework regulating AI-assisted trading.",
      namedEntities: ["SEC", "Bitcoin", "Ethereum", "Goldman Sachs"],
      centralClaims: [
        "SEC requires KYC for AI trading bots",
        "Crypto custody platforms must undergo mandatory audits",
        "Framework effective within 90 days",
      ],
    };

    expect(summary.title).toBe("SEC Joint AI-Crypto Framework");
    expect(summary.namedEntities).toHaveLength(4);
    expect(summary.centralClaims).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════
// C4: Community-influenced follow probability
// ═══════════════════════════════════════════════════════

describe("communityFollowProbability", () => {
  const overlaps = new Map<string, Map<string, number>>([
    ["comm-1", new Map([["comm-2", 0.4]])],
    ["comm-2", new Map([["comm-1", 0.4]])],
  ]);

  it("same community: higher follow probability", () => {
    const prob = communityFollowProbability("comm-1", "comm-1", overlaps, 0.3);
    expect(prob).toBeCloseTo(0.6); // 0.3 * 2.0
  });

  it("overlapping communities: moderate boost", () => {
    const prob = communityFollowProbability("comm-1", "comm-2", overlaps, 0.3);
    expect(prob).toBeGreaterThan(0.3); // boosted by overlap weight
    expect(prob).toBeLessThan(0.6); // but less than same-community
  });

  it("no overlap: reduced probability", () => {
    const prob = communityFollowProbability("comm-1", "comm-3", overlaps, 0.3);
    expect(prob).toBeCloseTo(0.15); // 0.3 * 0.5
  });

  it("null community: returns base density", () => {
    const prob = communityFollowProbability(null, "comm-1", overlaps, 0.3);
    expect(prob).toBe(0.3);
  });

  it("both null: returns base density", () => {
    const prob = communityFollowProbability(null, null, overlaps, 0.3);
    expect(prob).toBe(0.3);
  });
});

// ═══════════════════════════════════════════════════════
// C4: Community-influenced sentiment bias
// ═══════════════════════════════════════════════════════

describe("communitySentimentBias", () => {
  const proposals: CommunityProposal[] = [
    {
      name: "Crypto Bulls",
      description: "Supportive of crypto adoption, bullish on Bitcoin and Ethereum",
      memberLabels: ["crypto_trader_bullish", "fintech_founder"],
    },
    {
      name: "Regulation Hawks",
      description: "Critical of unregulated crypto, opposing loose compliance",
      memberLabels: ["sec_regulator", "compliance_officer"],
    },
    {
      name: "Neutral Observers",
      description: "Balanced coverage of market events",
      memberLabels: ["financial_journalist"],
    },
  ];

  it("nudges sentiment positive for supportive communities", () => {
    const original = 0.3;
    const biased = communitySentimentBias("crypto-bulls", proposals, original);
    expect(biased).toBeGreaterThan(original);
  });

  it("nudges sentiment negative for opposing communities", () => {
    const original = -0.2;
    const biased = communitySentimentBias("regulation-hawks", proposals, original);
    expect(biased).toBeLessThan(original);
  });

  it("does not change sentiment for neutral communities", () => {
    const original = 0.1;
    const biased = communitySentimentBias("neutral-observers", proposals, original);
    expect(biased).toBe(original);
  });

  it("returns original sentiment when no community match", () => {
    const original = 0.5;
    const biased = communitySentimentBias("unknown-comm", proposals, original);
    expect(biased).toBe(original);
  });

  it("returns original sentiment when community is null", () => {
    const original = -0.3;
    const biased = communitySentimentBias(null, proposals, original);
    expect(biased).toBe(original);
  });
});
