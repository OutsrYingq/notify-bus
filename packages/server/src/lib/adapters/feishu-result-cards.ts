import type { EventMessage } from "../../types";
import {
  asNum,
  asObj,
  asStr,
  markdown,
  md,
  navigationButtons,
  shortSha,
  truncate,
  type CardColor,
  type CardElement,
  type FeishuCard,
  type TagColor,
} from "./feishu-card-kit";

// ─── result-state cards (opt-in events) ────────────────────────────────────

export type ResultTone = "success" | "attention" | "failure" | "cancelled" | "inactive" | "neutral";

/** Keep the result palette consistent without conflating the events' raw states. */
function resultVisual(tone: ResultTone): { header: CardColor; badge: TagColor } {
  switch (tone) {
    case "success":
      return { header: "green", badge: "green" };
    case "attention":
      return { header: "orange", badge: "orange" };
    case "failure":
      return { header: "red", badge: "red" };
    case "cancelled":
      return { header: "grey", badge: "neutral" };
    case "inactive":
      return { header: "grey", badge: "neutral" };
    case "neutral":
      return { header: "blue", badge: "blue" };
  }
}

function reviewTone(state: string): ResultTone {
  if (state === "approved") return "success";
  if (state === "changes_requested") return "attention";
  if (state === "dismissed") return "cancelled";
  return "neutral";
}

function workflowTone(conclusion: string | undefined): ResultTone {
  if (!conclusion) return "neutral";
  if (conclusion === "success") return "success";
  if (conclusion === "action_required") return "attention";
  if (conclusion === "neutral") return "attention";
  if (conclusion === "cancelled" || conclusion === "stale" || conclusion === "skipped") {
    return "cancelled";
  }
  // Unknown terminal conclusions must not look like a successful or running job.
  return "failure";
}

function deploymentTone(state: string): ResultTone {
  if (state === "success") return "success";
  if (state === "failure" || state === "error") return "failure";
  if (state === "inactive") return "inactive"; // defensive: GitHub does not emit it
  return "neutral";
}

/** GitHub fields may be absent or whitespace-only; never turn either into a link. */
function firstNonBlank(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value?.trim())?.trim();
}

function repoUrl(message: EventMessage): string {
  return message.repository.html_url;
}

function stateLabel(state: string): string {
  return state.replace(/_/g, " ");
}

function resultHeader(
  title: string,
  repo: string,
  tone: ResultTone,
  state: string,
): FeishuCard["header"] {
  const visual = resultVisual(tone);
  return {
    title,
    subtitle: repo,
    template: visual.header,
    // One result badge leaves room under Feishu's three-badge limit.
    badges: [{ text: stateLabel(state), color: visual.badge }],
  };
}

export function buildReviewCard(message: EventMessage, body: string): FeishuCard {
  const review = asObj(message.payload.review);
  const pr = asObj(message.payload.pull_request);
  const state =
    message.action === "dismissed"
      ? "dismissed"
      : (firstNonBlank(asStr(review.state)) ?? "unknown");
  const reviewer = firstNonBlank(asStr(asObj(review.user).login));
  const number = asNum(pr.number) ?? asNum(message.payload.number);
  const title = firstNonBlank(asStr(pr.title)) ?? "(untitled)";
  const head = firstNonBlank(asStr(asObj(pr.head).ref));
  const base = firstNonBlank(asStr(asObj(pr.base).ref));
  const reviewBody = truncate(asStr(review.body), 300);
  const url = firstNonBlank(asStr(review.html_url));

  const lines = [
    `### ${md(title)}${number === undefined ? "" : ` #${number}`}`,
    `Review: **${md(stateLabel(state))}**`,
  ];
  if (reviewer) lines.push(`👤 **${md(reviewer)}**`);
  if (head && base) lines.push(`🔀 \`${md(head)}\` → \`${md(base)}\``);
  if (reviewBody) lines.push(`> ${md(reviewBody).replace(/\n/g, "\n> ")}`);
  const elements: CardElement[] = [markdown(lines.join("\n"))];
  if (body) elements.push(markdown(body));
  elements.push(
    ...navigationButtons([{ label: "View Review", url, type: "primary" }], repoUrl(message)),
  );
  return {
    header: resultHeader("🔎 PR review", message.repository.full_name, reviewTone(state), state),
    elements,
  };
}

export function buildWorkflowRunCard(message: EventMessage, body: string): FeishuCard {
  const run = asObj(message.payload.workflow_run);
  const name =
    firstNonBlank(asStr(run.name), asStr(run.display_title), asStr(run.path)) ?? "Workflow run";
  const conclusion = firstNonBlank(asStr(run.conclusion));
  const status = firstNonBlank(asStr(run.status));
  const state = conclusion ?? status ?? "unknown";
  const runNumber = asNum(run.run_number);
  const attempt = asNum(run.run_attempt);
  const branch = firstNonBlank(asStr(run.head_branch));
  const sha = firstNonBlank(asStr(run.head_sha));
  const url = firstNonBlank(asStr(run.html_url));
  const lines = [`### ${md(name)}`, `Result: **${md(stateLabel(state))}**`];
  if (runNumber !== undefined)
    lines.push(`Run #${runNumber}${attempt === undefined ? "" : ` · attempt ${attempt}`}`);
  else if (attempt !== undefined) lines.push(`Attempt ${attempt}`);
  if (branch) lines.push(`🔀 \`${md(branch)}\``);
  if (sha) lines.push(`Commit \`${md(shortSha(sha))}\``);
  const elements: CardElement[] = [markdown(lines.join("\n"))];
  if (body) elements.push(markdown(body));
  elements.push(
    ...navigationButtons([{ label: "View Run", url, type: "primary" }], repoUrl(message)),
  );
  return {
    header: resultHeader(
      `⚙️ ${name}`,
      message.repository.full_name,
      workflowTone(conclusion),
      state,
    ),
    elements,
  };
}

export function buildDeploymentStatusCard(message: EventMessage, body: string): FeishuCard {
  const status = asObj(message.payload.deployment_status);
  const deployment = asObj(message.payload.deployment);
  const state = firstNonBlank(asStr(status.state)) ?? "unknown";
  const environment = firstNonBlank(asStr(status.environment), asStr(deployment.environment));
  const ref = firstNonBlank(asStr(deployment.ref));
  const description = truncate(asStr(status.description), 300);
  const creator = asObj(status.creator);
  const creatorLogin = creator.type === "Bot" ? undefined : firstNonBlank(asStr(creator.login));
  const destinations = [
    { url: firstNonBlank(asStr(status.environment_url)), label: "View Environment" },
    { url: firstNonBlank(asStr(status.log_url)), label: "View Logs" },
    { url: firstNonBlank(asStr(status.target_url)), label: "View Target" },
    { url: firstNonBlank(asStr(asObj(message.payload.workflow_run).html_url)), label: "View Run" },
  ];
  const destination = destinations.find((candidate) => candidate.url);
  const lines = [`Deployment: **${md(stateLabel(state))}**`];
  if (environment) lines.push(`🌍 ${md(environment)}`);
  if (ref) lines.push(`🔀 \`${md(ref)}\``);
  if (description) lines.push(md(description));
  if (creatorLogin) lines.push(`👤 **${md(creatorLogin)}**`);
  const elements: CardElement[] = [markdown(lines.join("\n"))];
  if (body) elements.push(markdown(body));
  elements.push(
    ...navigationButtons(
      destination?.url ? [{ ...destination, type: "primary" }] : [],
      repoUrl(message),
    ),
  );
  return {
    header: resultHeader(
      "🚀 Deployment",
      message.repository.full_name,
      deploymentTone(state),
      state,
    ),
    elements,
  };
}
