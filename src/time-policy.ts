import type {
  ActorRow,
  NarrativeRow,
  PlatformState,
  RoundContext,
} from "./db.js";
import type { ActivationConfig, EventConfig, FatigueConfig } from "./config.js";
import { computeActivation } from "./activation.js";
import { processEvents } from "./events.js";
import { updateFatigue } from "./fatigue.js";
import { SeedablePRNG } from "./reproducibility.js";

export interface IdleFastForwardRound {
  roundNum: number;
  simTimestamp: string;
  narratives: NarrativeRow[];
}

export interface IdleFastForwardPlan {
  rounds: IdleFastForwardRound[];
  finalNarratives: NarrativeRow[];
  reason: string;
  pendingEvents: number;
}

export interface IdleFastForwardOptions {
  mode: "off" | "fast-forward";
  startRoundNum: number;
  totalRounds: number;
  currentSimTimestamp: string;
  currentState: PlatformState;
  currentEvents: RoundContext["activeEvents"];
  currentActiveActors: ActorRow[];
  currentNarratives: NarrativeRow[];
  allActors: ActorRow[];
  actorTopicsMap: Map<string, string[]>;
  activationConfig: ActivationConfig;
  eventsConfig: EventConfig;
  fatigueConfig: FatigueConfig;
  startTime: Date;
  minutesPerRound: number;
  maxFastForwardRounds: number;
  rng: RoundContext["rng"];
}

const EMPTY_PLATFORM_STATE: PlatformState = {
  runId: "",
  recentPosts: [],
  followGraph: new Map(),
  engagementByPost: new Map(),
  actors: new Map(),
  communities: [],
  exposedActors: new Map(),
};

export function shouldAttemptIdleFastForward(
  opts: Pick<
    IdleFastForwardOptions,
    "mode" | "currentState" | "currentEvents" | "currentActiveActors"
  >
): boolean {
  return (
    opts.mode === "fast-forward" &&
    opts.currentState.recentPosts.length === 0 &&
    opts.currentEvents.length === 0 &&
    opts.currentActiveActors.length === 0
  );
}

export function planIdleFastForward(
  opts: IdleFastForwardOptions
): IdleFastForwardPlan | null {
  if (!shouldAttemptIdleFastForward(opts)) {
    return null;
  }

  const rounds: IdleFastForwardRound[] = [
    {
      roundNum: opts.startRoundNum,
      simTimestamp: opts.currentSimTimestamp,
      narratives: opts.currentNarratives,
    },
  ];

  let latestNarratives = opts.currentNarratives;
  let previewRng = SeedablePRNG.fromState(opts.rng.state());
  const maxRounds = Math.max(1, opts.maxFastForwardRounds);

  for (
    let roundNum = opts.startRoundNum + 1;
    roundNum < opts.totalRounds && rounds.length < maxRounds;
    roundNum++
  ) {
    const simTimestamp = computeSimTimestamp(
      opts.startTime,
      roundNum,
      opts.minutesPerRound
    );
    const activeEvents = processEvents(
      roundNum,
      opts.eventsConfig,
      EMPTY_PLATFORM_STATE
    );
    if (activeEvents.length > 0) {
      return {
        rounds,
        finalNarratives: latestNarratives,
        reason: "quiet_tail_until_upcoming_event",
        pendingEvents: activeEvents.length,
      };
    }

    latestNarratives = updateFatigue(
      latestNarratives,
      roundNum,
      opts.fatigueConfig
    ).updated;

    const round: RoundContext = {
      runId: opts.currentState.runId,
      roundNum,
      simTimestamp,
      simHour: computeSimHour(simTimestamp),
      activeEvents,
      rng: previewRng,
    };
    const activation = computeActivation(
      opts.allActors,
      round,
      opts.activationConfig,
      opts.actorTopicsMap,
      latestNarratives
    );

    if (activation.activeActors.length > 0) {
      return {
        rounds,
        finalNarratives: rounds.at(-1)?.narratives ?? opts.currentNarratives,
        reason: "quiet_tail_until_next_activation",
        pendingEvents: 0,
      };
    }

    advanceRng(opts.rng, opts.allActors.length);
    previewRng = SeedablePRNG.fromState(previewRng.state());

    rounds.push({
      roundNum,
      simTimestamp,
      narratives: latestNarratives,
    });
  }

  return {
    rounds,
    finalNarratives: latestNarratives,
    reason: "quiet_tail_window_exhausted",
    pendingEvents: 0,
  };
}

function computeSimTimestamp(
  startTime: Date,
  roundNum: number,
  minutesPerRound: number
): string {
  const ms = startTime.getTime() + roundNum * minutesPerRound * 60 * 1000;
  return new Date(ms).toISOString().replace("Z", "").slice(0, 19);
}

function computeSimHour(simTimestamp: string): number {
  const date = new Date(simTimestamp);
  return date.getUTCHours();
}

function advanceRng(rng: RoundContext["rng"], count: number): void {
  for (let i = 0; i < count; i++) {
    rng.next();
  }
}
