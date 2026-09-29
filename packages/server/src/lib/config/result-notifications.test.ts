/**
 * The opt-in "only failures" policy for result events (issue #35).
 *
 * This needs no new machinery — the route-local condition from #34 already
 * expresses it — so the file is the acceptance matrix for the shape the
 * commented examples in config.example.yaml document, not tests of new code.
 */
import { describe, expect, it } from "bun:test";
import { loadSeedConfig, resolveRoute } from "./index";
import type { SeedConfig } from "./index";
import type { EventMessage } from "../../types";
import { buildCard } from "../adapters/feishu-cards";

const EXAMPLE_PATH = `${import.meta.dir}/../../../../../config.example.yaml`;

/** The channel every config below dispatches to. */
const CHANNEL = { name: "ch", type: "feishu", webhook_url: "https://x", enabled: true };

/** A repo that asked for failures only, and nothing else. */
const failuresOnly: SeedConfig = {
  channels: [CHANNEL],
  routes: [
    {
      name: "ci-failures",
      match_repo: "*",
      match_event: "workflow_run",
      match_payload: [{ action: "completed", "workflow_run.conclusion": "failure" }],
      target_channel: "ch",
    },
    {
      name: "deployment-failures",
      match_repo: "*",
      match_event: "deployment_status",
      match_payload: [
        { "deployment_status.state": "failure" },
        { "deployment_status.state": "error" },
      ],
      target_channel: "ch",
    },
  ],
};

/** The behavior a repo had before this policy existed: name the event, get all of it. */
const everything: SeedConfig = {
  channels: [CHANNEL],
  routes: [
    {
      name: "all-results",
      match_repo: "*",
      match_event: "workflow_run,deployment_status",
      target_channel: "ch",
    },
  ],
};

function message(event: string, payload: Record<string, unknown>): EventMessage {
  return {
    id: "evt-1",
    event,
    repository: { full_name: "org/repo", html_url: "https://gh/o/r" },
    actor: { login: "alice", avatar_url: "" },
    payload,
    metadata: {},
  };
}

/** A `workflow_run` as GitHub sends it: an action, and a conclusion once it ends. */
function workflowRun(action: string, conclusion?: string): EventMessage {
  const run = { name: "CI", html_url: "https://gh/o/r/actions/runs/1" };
  return message("workflow_run", {
    action,
    workflow_run: conclusion === undefined ? run : { ...run, conclusion },
  });
}

/** A `deployment_status`, whose `action` is always `created` and whose state is the signal. */
function deploymentStatus(state?: string): EventMessage {
  const status = { environment: "production", environment_url: "https://prod.example" };
  return message("deployment_status", {
    action: "created",
    deployment_status: state === undefined ? status : { ...status, state },
    deployment: { ref: "main" },
  });
}

describe("failures-only · workflow_run (#35)", () => {
  const scenarios: Array<[string, string, string | undefined, boolean]> = [
    ["a completed run that failed", "completed", "failure", true],
    ["a completed run that succeeded", "completed", "success", false],
    ["a completed run that was cancelled", "completed", "cancelled", false],
    ["a completed run that timed out", "completed", "timed_out", false],
    ["a completed run that needs action", "completed", "action_required", false],
    ["a completed run that was skipped", "completed", "skipped", false],
    ["a completed run that went stale", "completed", "stale", false],
    ["a completed run that is neutral", "completed", "neutral", false],
    ["a run that failed to start", "completed", "startup_failure", false],
    ["a completed run carrying no conclusion", "completed", undefined, false],
    ["a run still in progress", "in_progress", undefined, false],
    ["a run that was only requested", "requested", undefined, false],
  ];

  for (const [label, action, conclusion, delivered] of scenarios) {
    it(`${delivered ? "delivers" : "refuses"} ${label}`, () => {
      const decision = resolveRoute(failuresOnly, workflowRun(action, conclusion));
      if (delivered) {
        expect(decision).toMatchObject({
          kind: "matched",
          match: { route: { name: "ci-failures" } },
        });
        return;
      }
      // Refused, not unrouted: the reason names the field that turned it away,
      // so a filtered result stays distinguishable from an event nobody wants.
      expect(decision).toMatchObject({
        kind: "ignored",
        ignored: { route: { name: "ci-failures" }, reason: "match_payload" },
      });
    });
  }
});

describe("failures-only · deployment_status (#35)", () => {
  const scenarios: Array<[string, string | undefined, boolean]> = [
    ["a deployment that failed", "failure", true],
    ["a deployment that errored", "error", true],
    ["a deployment that succeeded", "success", false],
    ["a deployment waiting for approval", "pending", false],
    ["a deployment that is queued", "queued", false],
    ["a deployment in progress", "in_progress", false],
    ["a deployment in a state we do not know", "waiting_for_something_new", false],
    ["a deployment with no state at all", undefined, false],
  ];

  for (const [label, state, delivered] of scenarios) {
    it(`${delivered ? "delivers" : "refuses"} ${label}`, () => {
      const decision = resolveRoute(failuresOnly, deploymentStatus(state));
      if (delivered) {
        expect(decision).toMatchObject({
          kind: "matched",
          match: { route: { name: "deployment-failures" } },
        });
        return;
      }
      expect(decision).toMatchObject({
        kind: "ignored",
        ignored: { route: { name: "deployment-failures" }, reason: "match_payload" },
      });
    });
  }
});

describe("failures-only · what the policy must not change (#35)", () => {
  it("still delivers every result on a route that names no condition", () => {
    // The policy is per route. A repo that wants the whole firehose keeps it,
    // and nothing about adding the failures-only route above changes that.
    for (const conclusion of ["failure", "success", "timed_out", "cancelled", undefined]) {
      expect(resolveRoute(everything, workflowRun("completed", conclusion))).toMatchObject({
        kind: "matched",
        match: { route: { name: "all-results" } },
      });
    }
    for (const state of ["failure", "error", "success", "pending", undefined]) {
      expect(resolveRoute(everything, deploymentStatus(state))).toMatchObject({
        kind: "matched",
        match: { route: { name: "all-results" } },
      });
    }
  });

  it("leaves both events opt-in in the shipped config", () => {
    const example = loadSeedConfig(EXAMPLE_PATH);
    if (!example) throw new Error("config.example.yaml did not load");
    const unwanted: Array<[string, EventMessage]> = [
      ["workflow_run", workflowRun("completed", "failure")],
      ["deployment_status", deploymentStatus("failure")],
      ["status", message("status", { state: "failure" })],
      ["check_run", message("check_run", { action: "completed" })],
      ["check_suite", message("check_suite", { action: "completed" })],
      ["workflow_job", message("workflow_job", { action: "completed" })],
    ];
    for (const [eventType, event] of unwanted) {
      expect([eventType, resolveRoute(example, event).kind]).toEqual([eventType, "no_route"]);
    }
  });

  it("keeps a red card and a refusal on the same event", () => {
    // The warning #35 pins down: `workflowTone` paints `timed_out` red, exactly
    // like a failure, and the delivery rule still refuses it. The colour is a
    // display choice and never decides.
    const timedOut = workflowRun("completed", "timed_out");
    expect(buildCard(timedOut).header.template).toBe("red");
    expect(resolveRoute(failuresOnly, timedOut)).toMatchObject({
      kind: "ignored",
      ignored: { reason: "match_payload" },
    });

    // The conclusion it does deliver keeps that same red card.
    const failed = workflowRun("completed", "failure");
    expect(buildCard(failed).header.template).toBe("red");
    expect(resolveRoute(failuresOnly, failed).kind).toBe("matched");
  });

  it("leaves the deployment card's own reading of the payload alone", () => {
    // `deployment_status.action` is `created` on every one of these events, so
    // reading it as the signal would misread all of them; the card ignores it
    // and the route keys off the state.
    const failed = deploymentStatus("failure");
    const card = buildCard(failed);
    expect(card.header.badges?.[0]?.text).toBe("failure");
    expect(card.header.template).toBe("red");
    expect(resolveRoute(failuresOnly, failed).kind).toBe("matched");
  });
});
