/**
 * The route-local payload condition (`match_payload`), and the default policy
 * the shipped config builds out of it (issue #34).
 *
 * The grammar is exercised through `resolveRoute` — the surface the webhook
 * route itself uses — so a passing test describes what a real event does, not
 * what an internal helper returns.
 */
import { describe, expect, it } from "bun:test";
import { loadSeedConfig, resolveRoute } from "./index";
import type { PayloadCondition, SeedConfig, SeedRoute } from "./index";
import type { EventMessage } from "../../types";

const EXAMPLE_PATH = `${import.meta.dir}/../../../../../config.example.yaml`;

/** The config a new deployment gets. */
const example = loadSeedConfig(EXAMPLE_PATH);
if (!example) throw new Error("config.example.yaml did not load");

function event(over: Partial<EventMessage> = {}): EventMessage {
  return {
    id: "evt-1",
    event: "push",
    repository: { full_name: "org/repo", html_url: "https://gh/o/r" },
    actor: { login: "alice", avatar_url: "" },
    payload: {},
    metadata: {},
    ...over,
  };
}

/**
 * A push as the webhook route builds one: `ref` mirrored out of the payload,
 * no `action` (push carries none), and a repository defaulting to `main` unless
 * the scenario overrides it.
 */
function push(payload: Record<string, unknown> = {}): EventMessage {
  return event({
    event: "push",
    ref: typeof payload.ref === "string" ? payload.ref : undefined,
    payload: { created: false, deleted: false, repository: { default_branch: "main" }, ...payload },
  });
}

function configWith(routes: SeedRoute[]): SeedConfig {
  return {
    channels: [{ name: "ch", type: "feishu", webhook_url: "https://x", enabled: true }],
    routes,
  };
}

/** Whether a single push route carrying `condition` accepts `payload`. */
function accepts(
  condition: PayloadCondition | PayloadCondition[],
  payload: Record<string, unknown>,
): boolean {
  const route: SeedRoute = {
    name: "r",
    match_repo: "*",
    match_event: "push",
    match_payload: condition,
    target_channel: "ch",
  };
  return resolveRoute(configWith([route]), event({ payload })).kind === "matched";
}

describe("match_payload · clause grammar", () => {
  it("ANDs the keys inside one clause", () => {
    const condition: PayloadCondition[] = [{ ref: "refs/heads/main", created: true }];
    expect(accepts(condition, { ref: "refs/heads/main", created: true })).toBe(true);
    expect(accepts(condition, { ref: "refs/heads/main", created: false })).toBe(false);
    expect(accepts(condition, { created: true })).toBe(false);
  });

  it("ORs the clauses", () => {
    const condition: PayloadCondition[] = [
      { ref: "refs/heads/main" },
      { ref: "refs/heads/release/*" },
    ];
    expect(accepts(condition, { ref: "refs/heads/main" })).toBe(true);
    expect(accepts(condition, { ref: "refs/heads/release/1.x" })).toBe(true);
    expect(accepts(condition, { ref: "refs/heads/feature/x" })).toBe(false);
  });

  it("accepts one clause without the list wrapper", () => {
    expect(accepts({ ref: "refs/heads/main" }, { ref: "refs/heads/main" })).toBe(true);
    expect(accepts({ ref: "refs/heads/main" }, { ref: "refs/heads/other" })).toBe(false);
  });

  it("treats an absent condition and an empty clause list as no condition", () => {
    const route: SeedRoute = { name: "r", match_event: "push", target_channel: "ch" };
    expect(resolveRoute(configWith([route]), event({ payload: { ref: "anything" } })).kind).toBe(
      "matched",
    );
    expect(accepts([], { ref: "anything" })).toBe(true);
  });

  it("never matches a path the payload does not carry", () => {
    // Absent is not false: GitHub omits fields between payload versions, and a
    // missing `deleted` must not read as "this was not a deletion".
    expect(accepts({ deleted: false }, { deleted: false })).toBe(true);
    expect(accepts({ deleted: false }, {})).toBe(false);
    expect(accepts({ "repository.default_branch": "*" }, { repository: {} })).toBe(false);
  });

  it("never matches a non-scalar payload value", () => {
    expect(accepts({ repository: "*" }, { repository: { full_name: "org/repo" } })).toBe(false);
    expect(accepts({ labels: "*" }, { labels: [{ name: "bug" }] })).toBe(false);
  });

  it("compares values as text, so unquoted YAML booleans and numbers work", () => {
    expect(accepts({ created: true }, { created: true })).toBe(true);
    expect(accepts({ created: "true" }, { created: true })).toBe(true);
    expect(accepts({ run_attempt: 2 }, { run_attempt: 2 })).toBe(true);
    expect(accepts({ run_attempt: 2 }, { run_attempt: 3 })).toBe(false);
  });

  it("matches a dotted path into a nested object", () => {
    // The shape #35 needs: a CI conclusion, not a top-level field.
    const condition: PayloadCondition[] = [
      { action: "completed", "workflow_run.conclusion": "failure" },
    ];
    expect(
      accepts(condition, { action: "completed", workflow_run: { conclusion: "failure" } }),
    ).toBe(true);
    expect(
      accepts(condition, { action: "completed", workflow_run: { conclusion: "success" } }),
    ).toBe(false);
    expect(accepts(condition, { action: "requested", workflow_run: {} })).toBe(false);
  });

  it("lets `*` match any run of characters, anywhere in the value", () => {
    expect(accepts({ ref: "refs/heads/*" }, { ref: "refs/heads/main" })).toBe(true);
    expect(accepts({ ref: "refs/heads/*" }, { ref: "refs/tags/v1" })).toBe(false);
    expect(accepts({ ref: "*/hotfix" }, { ref: "refs/heads/hotfix" })).toBe(true);
    expect(accepts({ ref: "*" }, { ref: "refs/heads/anything" })).toBe(true);
  });

  it("reads $default_branch from the payload instead of assuming main", () => {
    const condition: PayloadCondition[] = [{ ref: "refs/heads/$default_branch" }];
    expect(
      accepts(condition, { ref: "refs/heads/develop", repository: { default_branch: "develop" } }),
    ).toBe(true);
    expect(
      accepts(condition, { ref: "refs/heads/main", repository: { default_branch: "develop" } }),
    ).toBe(false);
  });

  it("refuses a $default_branch clause when the payload carries no default branch", () => {
    const condition: PayloadCondition[] = [{ ref: "refs/heads/$default_branch" }];
    expect(accepts(condition, { ref: "refs/heads/main" })).toBe(false);
    expect(accepts(condition, { ref: "refs/heads/main", repository: {} })).toBe(false);
    expect(accepts(condition, { ref: "refs/heads/main", repository: { default_branch: "" } })).toBe(
      false,
    );
  });
});

describe("match_payload · routing semantics", () => {
  const quiet: SeedRoute = {
    name: "quiet",
    match_repo: "*",
    match_event: "push",
    match_payload: [{ ref: "refs/heads/main" }],
    target_channel: "ch",
    priority: 10,
  };
  const catchAll: SeedRoute = {
    name: "everything-else",
    match_repo: "*",
    match_event: "push",
    target_channel: "ch",
    priority: 100,
  };

  it("falls through to a later route the condition did not exclude", () => {
    expect(
      resolveRoute(configWith([quiet, catchAll]), event({ payload: { ref: "refs/heads/x" } })),
    ).toMatchObject({ kind: "matched", match: { route: { name: "everything-else" } } });
  });

  it("reports a payload refusal as ignored/match_payload, never as no_route", () => {
    // The distinction the webhook surfaces: a policy refused this event, which
    // is not the same as no route ever wanting it.
    expect(resolveRoute(configWith([quiet]), event({ payload: { ref: "refs/heads/x" } }))).toEqual({
      kind: "ignored",
      ignored: { route: quiet, reason: "match_payload" },
    });
    expect(resolveRoute(configWith([]), event({ payload: { ref: "refs/heads/x" } }))).toEqual({
      kind: "no_route",
    });
  });

  it("leaves a route without a condition matching its whole event domain", () => {
    // Routes written before match_payload existed must not start filtering.
    const comments: SeedRoute = {
      name: "conversation",
      match_repo: "*",
      match_event: "issue_comment",
      target_channel: "ch",
    };
    for (const action of ["created", "edited", "deleted"]) {
      expect(
        resolveRoute(configWith([comments]), event({ event: "issue_comment", action })),
      ).toMatchObject({ kind: "matched", match: { route: { name: "conversation" } } });
    }
  });

  it("keeps a whole-conversation issue_comment route working next to the shipped routes", () => {
    // The policy change must be opt-in per route: adding the shipped defaults
    // does not globally silence comments for someone who subscribed to them.
    const conversation: SeedRoute = {
      name: "conversation",
      match_repo: "*",
      match_event: "issue_comment",
      target_channel: "team-feishu",
      priority: 50,
    };
    const withConversation: SeedConfig = {
      ...example,
      routes: [...(example.routes ?? []), conversation],
    };
    for (const action of ["created", "edited", "deleted"]) {
      const message = event({ event: "issue_comment", action });
      expect(resolveRoute(withConversation, message)).toMatchObject({
        kind: "matched",
        match: { route: { name: "conversation" } },
      });
      // And it stays opt-in: the shipped three routes alone never deliver it.
      expect(resolveRoute(example, message)).toEqual({ kind: "no_route" });
    }
  });
});

describe("shipped config · push policy (#34)", () => {
  const scenarios: Array<{
    name: string;
    payload: Record<string, unknown>;
    outcome: "delivered" | "refused";
  }> = [
    {
      name: "a newly created branch's first push",
      payload: { ref: "refs/heads/feature/login", created: true },
      outcome: "delivered",
    },
    {
      name: "an update to the default branch",
      payload: { ref: "refs/heads/main" },
      outcome: "delivered",
    },
    {
      name: "a force push to the default branch",
      payload: { ref: "refs/heads/main", forced: true },
      outcome: "delivered",
    },
    {
      name: "a push on a repo whose default branch is not main",
      payload: { ref: "refs/heads/develop", repository: { default_branch: "develop" } },
      outcome: "delivered",
    },
    {
      name: "a new tag, even though GitHub sets created on it",
      payload: { ref: "refs/tags/v1.0.0", created: true },
      outcome: "refused",
    },
    {
      name: "a further push to a feature branch",
      payload: { ref: "refs/heads/feature/login" },
      outcome: "refused",
    },
    {
      name: "a force push to a feature branch",
      payload: { ref: "refs/heads/feature/login", forced: true },
      outcome: "refused",
    },
    {
      name: "a deleted feature branch",
      payload: { ref: "refs/heads/feature/login", deleted: true },
      outcome: "refused",
    },
    {
      name: "a deleted default branch",
      payload: { ref: "refs/heads/main", deleted: true },
      outcome: "refused",
    },
    {
      name: "a deleted tag",
      payload: { ref: "refs/tags/v1.0.0", deleted: true },
      outcome: "refused",
    },
    {
      name: "main on a repo whose default branch is develop",
      payload: { ref: "refs/heads/main", repository: { default_branch: "develop" } },
      outcome: "refused",
    },
    {
      name: "a push whose payload carries no default branch",
      payload: { ref: "refs/heads/main", repository: {} },
      outcome: "refused",
    },
  ];

  for (const { name, payload, outcome } of scenarios) {
    it(`${outcome === "delivered" ? "delivers" : "refuses"} ${name}`, () => {
      const decision = resolveRoute(example, push(payload));
      if (outcome === "delivered") {
        expect(decision).toMatchObject({
          kind: "matched",
          match: { route: { name: "pushes-to-team" }, channel: { name: "team-feishu" } },
        });
        return;
      }
      expect(decision).toMatchObject({
        kind: "ignored",
        ignored: { route: { name: "pushes-to-team" }, reason: "match_payload" },
      });
    });
  }

  it("leaves tag pushes to a route that asks for them by name", () => {
    // Nothing in the shipped push route excludes tags globally; a second route
    // can still take them, which is the fallthrough the refusal relies on.
    const tags: SeedRoute = {
      name: "tags",
      match_repo: "*",
      match_event: "push",
      match_payload: [{ ref: "refs/tags/*", created: true }],
      target_channel: "team-feishu",
      priority: 90,
    };
    const config: SeedConfig = { ...example, routes: [tags, ...(example.routes ?? [])] };
    expect(resolveRoute(config, push({ ref: "refs/tags/v1.0.0", created: true }))).toMatchObject({
      kind: "matched",
      match: { route: { name: "tags" } },
    });
  });
});

describe("shipped config · issues policy (#34)", () => {
  for (const action of ["opened", "closed", "reopened", "assigned"]) {
    it(`delivers issues.${action}`, () => {
      expect(resolveRoute(example, event({ event: "issues", action }))).toMatchObject({
        kind: "matched",
        match: { route: { name: "issues-to-team" }, channel: { name: "team-feishu" } },
      });
    });
  }

  for (const action of [
    "labeled",
    "unlabeled",
    "edited",
    "pinned",
    "unpinned",
    "locked",
    "milestoned",
    "demilestoned",
    "typed",
    "untyped",
    "unassigned",
    "transferred",
  ]) {
    it(`stays silent on issues.${action}`, () => {
      // A whitelist miss is not an ignore: no route named this action, so the
      // webhook reports `no_route` — distinguishable from the `match_payload`
      // refusal the push route reports.
      expect(resolveRoute(example, event({ event: "issues", action }))).toEqual({
        kind: "no_route",
      });
    });
  }

  it("lets a later route take an issue action the whitelist does not name", () => {
    // The refusal is route-local: churn no shipped route wants can still be
    // delivered by a route added below it.
    const churn: SeedRoute = {
      name: "issue-churn",
      match_repo: "*",
      match_event: "issues",
      target_channel: "team-feishu",
      priority: 200,
    };
    const config: SeedConfig = { ...example, routes: [...(example.routes ?? []), churn] };
    expect(resolveRoute(config, event({ event: "issues", action: "labeled" }))).toMatchObject({
      kind: "matched",
      match: { route: { name: "issue-churn" } },
    });
  });
});

describe("shipped config · pull_request and release keep their previous behavior (#34)", () => {
  for (const [eventType, action] of [
    ["pull_request", "opened"],
    ["pull_request", "closed"],
    ["pull_request", "reopened"],
    ["pull_request", "assigned"],
    ["pull_request", "unassigned"],
    ["pull_request", "review_requested"],
    ["pull_request", "review_request_removed"],
    ["pull_request", "synchronize"],
    ["pull_request", "labeled"],
    ["release", "published"],
    ["release", "unpublished"],
    ["release", "created"],
    ["release", "edited"],
    ["release", "prereleased"],
    ["release", "released"],
  ]) {
    it(`delivers ${eventType}.${action}`, () => {
      // Same-name actions as the issues route, delivered here: the issue
      // whitelist must not reach across into pull_request.
      expect(resolveRoute(example, event({ event: eventType, action }))).toMatchObject({
        kind: "matched",
        match: {
          route: { name: "pull-request-release-to-team" },
          channel: { name: "team-feishu" },
        },
      });
    });
  }
});
