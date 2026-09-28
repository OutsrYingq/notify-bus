import { describe, expect, it } from "bun:test";
import { buildCard } from "./feishu-cards";
import type { CardElement, FeishuCard } from "./feishu-card-kit";
import { renderFormatted } from "../render";
import type { EventMessage } from "../../types";

const repoUrl = "https://github.com/octo/repo";

function card(
  event: string,
  payload: Record<string, unknown>,
  action?: string,
  template?: string,
): FeishuCard {
  const message: EventMessage = {
    id: "delivery-1",
    event,
    action,
    repository: { full_name: "octo/repo", html_url: repoUrl },
    actor: { login: "sender", avatar_url: "" },
    payload: {
      repository: { full_name: "octo/repo", html_url: repoUrl },
      sender: { login: "sender" },
      ...payload,
    },
    metadata: {},
  };
  return buildCard(renderFormatted(message, template));
}

function text(result: FeishuCard): string {
  return result.elements
    .filter((element) => element.tag === "markdown")
    .map((element) => element.content)
    .join("\n");
}

function buttons(result: FeishuCard): { label: string; url: string; type: string }[] {
  const found: { label: string; url: string; type: string }[] = [];
  for (const element of result.elements) {
    if (element.tag === "button") {
      const button = element as {
        text?: { content?: string };
        type?: string;
        behaviors?: { default_url?: string }[];
      };
      found.push({
        label: button.text?.content ?? "",
        url: button.behaviors?.[0]?.default_url ?? "",
        type: button.type ?? "",
      });
    }
    if (element.tag === "column_set") {
      for (const column of (element.columns as { elements?: CardElement[] }[] | undefined) ?? []) {
        for (const nested of column.elements ?? []) {
          if (nested.tag !== "button") continue;
          const button = nested as {
            text?: { content?: string };
            type?: string;
            behaviors?: { default_url?: string }[];
          };
          found.push({
            label: button.text?.content ?? "",
            url: button.behaviors?.[0]?.default_url ?? "",
            type: button.type ?? "",
          });
        }
      }
    }
  }
  return found;
}

function reviewPayload(state: string, body: string | null | undefined = "Looks good") {
  return {
    action: "submitted",
    review: {
      state,
      body,
      html_url: "https://github.com/octo/repo/pull/42#pullrequestreview-7",
      user: { login: "reviewer" },
    },
    pull_request: {
      number: 42,
      title: "Fix <card>",
      head: { ref: "feature" },
      base: { ref: "main" },
      html_url: "https://github.com/octo/repo/pull/42",
    },
  };
}

function runPayload(conclusion: string | null, status = "completed") {
  return {
    action: "completed",
    workflow_run: {
      name: "CI",
      display_title: "checks",
      path: ".github/workflows/ci.yml",
      conclusion,
      status,
      run_number: 81,
      run_attempt: 2,
      head_branch: "main",
      head_sha: "abcdef1234567890",
      html_url: "https://github.com/octo/repo/actions/runs/81",
    },
  };
}

function deploymentPayload(state: string) {
  return {
    action: "created",
    deployment: { environment: "production", ref: "main" },
    deployment_status: {
      state,
      description: "Deployed <now>",
      creator: { login: "deploy-bot", type: "Bot" },
      environment_url: "https://example.com/environment",
      log_url: "https://example.com/log",
      target_url: "https://example.com/target",
    },
    workflow_run: { html_url: "https://github.com/octo/repo/actions/runs/81" },
  };
}

describe("result cards · pull_request_review (#20)", () => {
  for (const [state, color] of [
    ["approved", "green"],
    ["changes_requested", "orange"],
    ["commented", "blue"],
    ["dismissed", "grey"],
  ] as const) {
    it(`shows ${state} as visible text and result badge`, () => {
      const result = card("pull_request_review", reviewPayload(state), "submitted");
      expect(result.header.template).toBe(color);
      expect(result.header.badges?.[0]?.text).toBe(state.replace(/_/g, " "));
      expect(text(result)).toContain(state.replace(/_/g, " "));
      expect(text(result)).toContain("Fix &#60;card&#62; #42");
      expect(text(result)).toContain("reviewer");
      expect(text(result)).toContain("`feature` → `main`");
      expect(buttons(result)).toEqual([
        {
          label: "View Review",
          url: "https://github.com/octo/repo/pull/42#pullrequestreview-7",
          type: "primary",
        },
        { label: "View Repo", url: repoUrl, type: "default" },
      ]);
    });
  }

  it("makes a dismissed action visible even if the payload still says commented", () => {
    const result = card("pull_request_review", reviewPayload("commented"), "dismissed");
    expect(result.header.badges?.[0]?.text).toBe("dismissed");
    expect(text(result)).toContain("dismissed");
  });

  for (const body of [null, undefined, ""] as const) {
    it(`omits an empty quote for body ${String(body)}`, () => {
      const payload = reviewPayload("approved", body);
      if (body === undefined) delete (payload.review as { body?: string | null }).body;
      const result = card("pull_request_review", payload);
      expect(text(result)).not.toContain("\n>");
    });
  }

  it("omits a dead link and appends complementary template markdown", () => {
    const payload = reviewPayload("approved");
    payload.review.html_url = "";
    const result = card("pull_request_review", payload, "submitted", "Extra {{event}}");
    expect(buttons(result)).toEqual([{ label: "View Repo", url: repoUrl, type: "default" }]);
    expect(text(result)).toContain("Looks good");
    expect(text(result)).toContain("Extra pull_request_review");
  });
});

describe("result cards · workflow_run (#20)", () => {
  for (const [state, color] of [
    ["success", "green"],
    ["failure", "red"],
    ["cancelled", "grey"],
    ["action_required", "orange"],
    ["timed_out", "red"],
    ["startup_failure", "red"],
    ["neutral", "orange"],
    ["stale", "grey"],
    ["skipped", "grey"],
  ] as const) {
    it(`shows ${state} without conflating it with running or success`, () => {
      const result = card("workflow_run", runPayload(state), "completed");
      expect(result.header.template).toBe(color);
      expect(result.header.badges?.[0]?.text).toBe(state.replace(/_/g, " "));
      expect(text(result)).toContain(`Result: **${state.replace(/_/g, " ")}**`);
      expect(text(result)).toContain("Run #81 · attempt 2");
      expect(text(result)).toContain("`main`");
      expect(text(result)).toContain("`abcdef1`");
      expect(result.header.title).toBe("⚙️ CI");
      expect(buttons(result)).toEqual([
        { label: "View Run", url: "https://github.com/octo/repo/actions/runs/81", type: "primary" },
        { label: "View Repo", url: repoUrl, type: "default" },
      ]);
    });
  }

  it("uses status when an in-progress run has no conclusion", () => {
    const result = card("workflow_run", runPayload(null, "in_progress"), "in_progress");
    expect(result.header.template).toBe("blue");
    expect(result.header.badges?.[0]?.text).toBe("in progress");
    expect(text(result)).toContain("Result: **in progress**");
  });

  for (const [name, display, path, expected] of [
    ["", "checks", "file.yml", "checks"],
    [" ", "", "file.yml", "file.yml"],
    ["", "", " ", "Workflow run"],
  ] as const) {
    it(`selects the first nonblank run title: ${expected}`, () => {
      const payload = runPayload("success");
      payload.workflow_run.name = name;
      payload.workflow_run.display_title = display;
      payload.workflow_run.path = path;
      expect(card("workflow_run", payload).header.title).toBe(`⚙️ ${expected}`);
      expect(text(card("workflow_run", payload))).toContain(`### ${expected}`);
    });
  }

  it("does not fabricate a run URL", () => {
    const payload = runPayload("success");
    payload.workflow_run.html_url = "";
    expect(buttons(card("workflow_run", payload))).toEqual([
      { label: "View Repo", url: repoUrl, type: "default" },
    ]);
  });
});

describe("result cards · deployment_status (#20)", () => {
  for (const [state, color] of [
    ["queued", "blue"],
    ["pending", "blue"],
    ["in_progress", "blue"],
    ["success", "green"],
    ["failure", "red"],
    ["error", "red"],
  ] as const) {
    it(`shows deployment state ${state} in text as well as a badge`, () => {
      const result = card("deployment_status", deploymentPayload(state), "created");
      expect(result.header.template).toBe(color);
      expect(result.header.badges?.[0]?.text).toBe(state.replace(/_/g, " "));
      expect(text(result)).toContain(`Deployment: **${state.replace(/_/g, " ")}**`);
      expect(text(result)).toContain("production");
      expect(text(result)).toContain("`main`");
      expect(text(result)).toContain("Deployed &#60;now&#62;");
      expect(text(result)).not.toContain("deploy-bot");
      expect(buttons(result)).toEqual([
        { label: "View Environment", url: "https://example.com/environment", type: "primary" },
        { label: "View Repo", url: repoUrl, type: "default" },
      ]);
    });
  }

  it("uses creator.type, not the login suffix, to identify a human", () => {
    const payload = deploymentPayload("success");
    payload.deployment_status.creator = { login: "human-bot", type: "User" };
    expect(text(card("deployment_status", payload))).toContain("human-bot");
  });

  it("selects environment, log, target, then workflow run URL without a dead button", () => {
    const payload = deploymentPayload("success");
    payload.deployment_status.environment_url = " ";
    expect(buttons(card("deployment_status", payload))).toEqual([
      { label: "View Logs", url: "https://example.com/log", type: "primary" },
      { label: "View Repo", url: repoUrl, type: "default" },
    ]);
    payload.deployment_status.log_url = "";
    expect(buttons(card("deployment_status", payload))).toEqual([
      { label: "View Target", url: "https://example.com/target", type: "primary" },
      { label: "View Repo", url: repoUrl, type: "default" },
    ]);
    payload.deployment_status.target_url = "";
    expect(buttons(card("deployment_status", payload))).toEqual([
      { label: "View Run", url: "https://github.com/octo/repo/actions/runs/81", type: "primary" },
      { label: "View Repo", url: repoUrl, type: "default" },
    ]);
    payload.workflow_run.html_url = "";
    expect(buttons(card("deployment_status", payload))).toEqual([
      { label: "View Repo", url: repoUrl, type: "default" },
    ]);
  });

  it("treats inactive defensively without misreporting success", () => {
    const result = card("deployment_status", deploymentPayload("inactive"));
    expect(result.header.badges?.[0]?.text).toBe("inactive");
    expect(result.header.template).toBe("grey");
  });
});

it("keeps result cards within Feishu's three-badge limit", () => {
  const results = [
    card("pull_request_review", reviewPayload("approved")),
    card("workflow_run", runPayload("success")),
    card("deployment_status", deploymentPayload("success")),
    card("push", { commits: [] }),
    card("pull_request", { pull_request: { title: "PR" } }),
    card("issues", { issue: { title: "Issue" } }),
    card("release", { release: { name: "Release" } }),
    card("star", {}),
    card("fork", { forkee: { html_url: "https://github.com/fork/repo" } }),
    card("other", {}),
  ];
  for (const result of results) {
    expect(result.header.badges?.length ?? 0).toBeLessThanOrEqual(3);
  }
});
