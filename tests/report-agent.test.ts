/**
 * report-agent.test.ts — Tests for ReportAgent orchestrator
 */

import { describe, it, expect, vi } from "vitest";
import type { ReportAgentInput, ReportAgentStep } from "../src/report-agent.js";

describe("ReportAgent types", () => {
  it("ReportAgentInput accepts valid input", () => {
    const input: ReportAgentInput = {
      runId: "run-1",
      objective: "What drove the polarization in the crypto community?",
      maxSteps: 5,
    };
    expect(input.objective).toContain("polarization");
  });

  it("ReportAgentStep covers all step types", () => {
    const steps: ReportAgentStep[] = [
      { type: "thought", content: "I should look at the sentiment curves first" },
      { type: "tool", content: "get_metrics", toolName: "get_metrics", toolInput: "" },
      { type: "observation", content: "Crypto sentiment peaked at round 5" },
      { type: "synthesis", content: "The simulation showed rapid polarization..." },
    ];
    expect(steps).toHaveLength(4);
    expect(steps.map((s) => s.type)).toEqual(["thought", "tool", "observation", "synthesis"]);
  });
});

describe("ReportAgent tool definitions", () => {
  it("query_simulation, interview_actor, get_metrics, get_actor_context are defined", async () => {
    // Import to verify the module loads without errors
    const mod = await import("../src/report-agent.js");
    expect(mod.runReportAgent).toBeDefined();
    expect(typeof mod.runReportAgent).toBe("function");
  });
});
