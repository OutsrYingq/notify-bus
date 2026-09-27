/**
 * Per-event Feishu card builders (schema 2.0).
 *
 * Translates an {@link EventMessage} into a rich card: a typed header (with
 * optional badge pills), a body of elements (markdown, column layouts, stat
 * tiles, link buttons, dividers). The whole card is NOT clickable — links
 * live in explicit buttons and inline markdown links.
 *
 * v2 schema notes (verified against the Feishu docs):
 *   - Buttons link via `behaviors:[{type:"open_url", default_url}]`, not a
 *     top-level `url` (that's the deprecated v1 shorthand).
 *   - Buttons go directly in `elements`; the v1 `tag:"action"` wrapper is gone.
 *   - The v1 `note` element is gone — use a `div` with small grey text instead.
 *   - Inside markdown/lark_md: `<text_tag color="green">label</text_tag>`
 *     renders a colored pill; `<font color="green">+42</font>` colors text.
 *
 * This module owns *structure* (colors, layout, buttons). The body markdown
 * comes from `message.formatted?.body` — the configured template's rendered
 * output, or empty when no template is configured — and is folded in as extra
 * content.
 */
import type { EventMessage } from "../../types";

/** Header color theme (Feishu enum). */
export type CardColor =
  | "blue"
  | "wathet"
  | "turquoise"
  | "green"
  | "yellow"
  | "orange"
  | "red"
  | "carmine"
  | "violet"
  | "purple"
  | "indigo"
  | "grey";

/** text_tag / font color (superset of header colors incl. `neutral`, `lime`). */
export type TagColor =
  | "neutral"
  | "blue"
  | "turquoise"
  | "lime"
  | "orange"
  | "violet"
  | "indigo"
  | "wathet"
  | "green"
  | "yellow"
  | "red"
  | "purple"
  | "carmine";

/** A card body element — a permissive shape covering all the tags we emit. */
export type CardElement = Record<string, unknown>;

/** A header suffix badge (renders as a colored pill next to the title). */
export interface HeaderBadge {
  text: string;
  color: TagColor;
}

/** The shape returned by buildCard: the parts of a Feishu card we control. */
export interface FeishuCard {
  header: {
    title: string;
    subtitle?: string;
    template: CardColor;
    badges?: HeaderBadge[];
  };
  elements: CardElement[];
}

// ─── payload accessors ─────────────────────────────────────────────────────

function asObj(value: unknown): Record<string, unknown> {
  return (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
}
function asStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asNum(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
function asArr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ─── text helpers ──────────────────────────────────────────────────────────

/** Short sha (first 7 chars). */
function shortSha(sha: string | undefined): string {
  return sha && sha.length > 7 ? sha.slice(0, 7) : (sha ?? "");
}

/** `refs/heads/main` → `main`, `refs/tags/v1` → `v1`. */
function extractBranch(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  return ref.replace(/^refs\/(heads|tags)\//, "");
}

/** Truncate + ellipsis. Returns "" for empty/whitespace. */
function truncate(text: string | undefined, max: number): string {
  const clean = (text ?? "").replace(/\r/g, "").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).trimEnd()}…`;
}

/** First line of a commit message, truncated. */
function firstLine(msg: string | undefined, max = 120): string {
  return truncate(msg, max)?.split("\n")[0] ?? "";
}

/**
 * Make a value from the GitHub payload safe to embed in card markdown.
 *
 * Everything user-controlled reaches the card through here: commit messages,
 * issue/PR titles and bodies, comments, branch names, labels, logins. Feishu's
 * card markdown recognises a set of HTML-like tags (`<at>`, `<font>`,
 * `<text_tag>`, `<a>`, ...), so without escaping a commit message could smuggle
 * one in and have it executed as card markup — forging styling, or (for
 * `<at id=all>`) making the entire card fail to send (#16).
 *
 * Feishu's documented escaping form is the *numeric* entity (`&#60;` for `<`,
 * `&#62;` for `>`), not the named `&lt;` / `&gt;` forms.
 *
 * Markup this module generates is concatenated *around* the escaped text (see
 * {@link textTag} and {@link colored}) and never passes through here, so
 * generated tags keep working while user-supplied ones are neutralised.
 *
 * Note: `>` is escaped too, which means a literal quote line inside a PR or
 * issue body renders as text rather than as a blockquote. That is deliberate —
 * user text should not control card layout, and the platform lists `&#62;` in
 * its escaping table.
 */
function md(text: string | undefined): string {
  return (
    (text ?? "")
      // `&` first, so the entities introduced below are not double-escaped.
      .replace(/&/g, "&#38;")
      .replace(/</g, "&#60;")
      .replace(/>/g, "&#62;")
      .replace(/\|/g, "\\|")
      .trim()
  );
}

/** A `<text_tag>` pill, for embedding inside markdown content. */
function textTag(color: TagColor, text: string): string {
  return `<text_tag color="${color}">${md(text)}</text_tag>`;
}

/** Colored inline text via `<font>`, for stats like +42 / -7. */
function colored(color: TagColor, text: string): string {
  return `<font color="${color}">${md(text)}</font>`;
}

/** A markdown link, only if url is present. */
function maybeLink(label: string, url: string | undefined): string {
  return url ? `[${md(label)}](${url})` : md(label);
}

// ─── payload field resolution ──────────────────────────────────────────────
//
// GitHub reports "what an event is about" in a different field for every event
// shape. The fallback card used to read exactly one of them
// (`membership.user`) and fall back to the sender, which silently named the
// wrong person — `member` keeps the affected user in `member`, and
// `member_invited` has no `membership` object at all (#17).

/** Where each event keeps the person it is about. */
const SUBJECT_FIELD: Record<string, string> = {
  member: "member",
  membership: "member",
  org_block: "blocked_user",
};

/**
 * Who an event is about.
 *
 * The last two variants must stay distinct. `unnamed` means the event is about
 * a person the payload does not name, so naming the actor would assert
 * something the payload never said; `not-a-person-event` means the event is not
 * about anyone (`create`, `delete`, `workflow_run`, ...), where naming the
 * actor is correct. Collapsing them would either name the wrong person or print
 * "unknown" across the ~30 event types that have no dedicated builder.
 */
type EventSubject =
  | { kind: "login"; login: string; htmlUrl?: string }
  /** Identified only by email — the address itself is never surfaced. */
  | { kind: "email-invite" }
  | { kind: "unnamed" }
  | { kind: "not-a-person-event" };

function resolveEventSubject(
  event: string,
  action: string | undefined,
  payload: Record<string, unknown>,
): EventSubject {
  if (event === "organization") {
    // `organization` covers two unrelated shapes, so the action has to decide
    // what an unresolvable person means. The member-* actions are about another
    // person; `renamed` / `deleted` are about the organization itself, and
    // naming the actor there is correct — reporting `unknown` would drop the
    // one piece of information the payload does carry.
    const memberAction = action !== undefined && action.startsWith("member_");
    // member_added / member_removed carry `membership`. member_invited has no
    // `membership` at all; it puts the invitee in a top-level `user`, which —
    // unlike `invitation` — also carries an html_url.
    const membershipUser = asObj(asObj(payload.membership).user);
    const invitedUser = asObj(payload.user);
    const invitation = asObj(payload.invitation);
    const login =
      asStr(membershipUser.login) ?? asStr(invitedUser.login) ?? asStr(invitation.login);
    if (login) {
      return {
        kind: "login",
        login,
        htmlUrl: asStr(membershipUser.html_url) ?? asStr(invitedUser.html_url),
      };
    }
    // With only `invitation.email` left, the card says a person was invited
    // without printing the address: a Feishu card is visible to everyone in the
    // group, and an email is not public information.
    if (asStr(invitation.email)) return { kind: "email-invite" };
    // A prefix test rather than a fixed list: an unrecognised `member_*` action
    // then errs toward `unnamed`, which under-reports instead of naming the
    // wrong person.
    return memberAction ? { kind: "unnamed" } : { kind: "not-a-person-event" };
  }

  const field = SUBJECT_FIELD[event];
  if (field === undefined) return { kind: "not-a-person-event" };
  const person = asObj(payload[field]);
  const login = asStr(person.login);
  if (!login) return { kind: "unnamed" };
  return { kind: "login", login, htmlUrl: asStr(person.html_url) };
}

/** Context around a membership change that the payload exposes. */
interface MembershipDetails {
  /** `active` or `pending` — joined, or the invitation is still outstanding. */
  state?: string;
  role?: string;
  /** Who sent the invitation. */
  inviterLogin?: string;
  /** Which team, for team membership and `team` / `team_add` events. */
  teamName?: string;
  teamUrl?: string;
  /**
   * The *previous* permission on `member` action `edited`. GitHub does not send
   * the new one, so this has to be worded as the old value — presenting it as
   * the current permission would be wrong.
   */
  previousPermission?: string;
}

function resolveMembershipDetails(
  payload: Record<string, unknown>,
): MembershipDetails {
  const membership = asObj(payload.membership);
  const team = asObj(payload.team);
  const invitation = asObj(payload.invitation);
  const oldPermission = asObj(asObj(payload.changes).old_permission);
  return {
    state: asStr(membership.state),
    role: asStr(membership.role),
    inviterLogin: asStr(asObj(invitation.inviter).login),
    teamName: asStr(team.name),
    teamUrl: asStr(team.html_url),
    previousPermission: asStr(oldPermission.from),
  };
}

/** Colours cycled through for issue/PR label pills. */
const LABEL_COLORS: TagColor[] = ["blue", "turquoise", "orange", "violet", "green"];

/** How many label pills a card shows before summarising the rest. */
const MAX_LABELS = 3;

/**
 * Render labels as coloured pills, stating how many were left out.
 *
 * Issues used to render `labels.slice(0, 3)` with no remainder, so a card with
 * ten labels looked exactly like a card with three (#17).
 */
function renderLabels(labels: readonly string[]): string {
  const shown = labels
    .slice(0, MAX_LABELS)
    .map((label, i) => textTag(LABEL_COLORS[i % LABEL_COLORS.length]!, label));
  const overflow = labels.length - shown.length;
  return `🏷️ ${shown.join(" ")}${overflow > 0 ? ` +${overflow} more` : ""}`;
}

/** Where a card's single button should point. */
interface PrimaryLink {
  url: string;
  label: string;
}

/**
 * Pick the most specific target available: the comment the event is about, else
 * the repo (or the org, for org-scoped events).
 *
 * Returns null when there is no usable URL — a button with an empty
 * `default_url` does nothing when clicked (#6).
 */
function resolvePrimaryLink(
  payload: Record<string, unknown>,
  repoUrl: string,
): PrimaryLink | null {
  const commentUrl = asStr(asObj(payload.comment).html_url);
  if (commentUrl) return { url: commentUrl, label: "View Comment" };
  if (!repoUrl) return null;
  const hasRepository = payload.repository !== undefined && payload.repository !== null;
  return { url: repoUrl, label: hasRepository ? "View Repo" : "View Org" };
}

// ─── element constructors ──────────────────────────────────────────────────

function markdown(content: string): CardElement {
  return { tag: "markdown", content };
}

function hr(): CardElement {
  return { tag: "hr" };
}

/** A link button that opens `url`. */
function linkButton(
  label: string,
  url: string,
  type: "primary" | "default" = "primary",
): CardElement {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    size: "medium",
    behaviors: [{ type: "open_url", default_url: url }],
  };
}

/** Two buttons side by side. */
function buttonRow(
  left: { label: string; url: string; type?: "primary" | "default" },
  right: { label: string; url: string; type?: "primary" | "default" },
): CardElement {
  return columnSet([
    [linkButton(left.label, left.url, left.type ?? "primary")],
    [linkButton(right.label, right.url, right.type ?? "default")],
  ]);
}

/**
 * A column_set of equally-weighted columns. Each column is a list of elements.
 * Pairs nicely with markdown "info tiles" for author | stats layouts.
 */
function columnSet(columns: CardElement[][]): CardElement {
  return {
    tag: "column_set",
    flex_mode: "none",
    background_style: "default",
    columns: columns.map((elements) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      vertical_align: "top",
      elements,
    })),
  };
}

// ─── event-specific builders ───────────────────────────────────────────────

/**
 * GitHub truncates a push payload's `commits` array at this many entries ("The
 * array includes a maximum of 2048 commits"), so a length equal to the cap may
 * mean "exactly this many" or "longer and cut off".
 */
const MAX_PUSH_COMMITS = 2048;

function buildPushCard(message: EventMessage, body: string): FeishuCard {
  const p = message.payload;
  const repo = message.repository.full_name;
  const pusher =
    asStr(asObj(p.pusher).name) ?? asStr(asObj(p.sender).login) ?? message.actor.login;
  const branch = extractBranch(message.ref);
  const compare = asStr(p.compare);
  const commits = asArr(p.commits).map((c) => {
    const co = asObj(c);
    return {
      sha: shortSha(asStr(co.id)),
      message: asStr(co.message),
      author: asStr(asObj(co.author).name) ?? asStr(asObj(co.author).username),
      url: asStr(co.url),
    };
  });

  // The webhook push payload carries no total-count field: `total_commits` is
  // not a GitHub field (it exists on other forges), and `size`/`distinct_size`
  // appear only on the Events API. So the array length is the push size — but
  // at the cap it cannot be told apart from a longer push that was truncated,
  // so say "2048+" rather than assert a count we cannot know.
  const totalLabel =
    commits.length >= MAX_PUSH_COMMITS
      ? `${MAX_PUSH_COMMITS}+ commits`
      : `${commits.length} commit${commits.length === 1 ? "" : "s"}`;
  // A history rewrite and a branch deletion are both pushes that must not read
  // as an ordinary "N commits pushed". See #15.
  const forced = p.forced === true;
  const deleted = p.deleted === true;
  const created = p.created === true;

  const head = asObj(p.head_commit);
  const added = asArr(head.added).length;
  const modified = asArr(head.modified).length;
  const removed = asArr(head.removed).length;
  const changed = added + modified + removed;

  const elements: CardElement[] = [];

  // Info row: author + branch | file-change stats (colored).
  const leftCol = markdown(
    `👤 **${md(pusher)}**${branch ? `\n🔀 \`${md(branch)}\`` : ""}`,
  );
  const rightParts: string[] = [];
  if (changed > 0) {
    rightParts.push(
      `📁 ${colored("green", `+${added}`)} ${colored("orange", `~${modified}`)} ${colored("red", `-${removed}`)}`,
    );
  }
  // A deleted branch has no commit count to report, so the author goes
  // full-width rather than sharing the row with an empty or misleading column.
  if (!deleted) rightParts.push(`📦 ${totalLabel}`);
  if (rightParts.length > 0) {
    elements.push(columnSet([[leftCol], [markdown(rightParts.join("\n"))]]));
  } else {
    elements.push(leftCol);
  }

  elements.push(hr());

  // Commit list (capped at 5 + overflow note).
  if (commits.length > 0) {
    const max = 5;
    const shown = commits.slice(0, max);
    const lines = shown.map((c) => {
      const headSha = c.url ? `[\`${c.sha}\`](${c.url})` : `\`${c.sha}\``;
      const authorTag = c.author ? ` ${textTag("neutral", c.author)}` : "";
      return `- ${headSha} ${md(firstLine(c.message))}${authorTag}`;
    });
    const overflow = commits.length - shown.length;
    if (overflow > 0) {
      // At GitHub's cap the payload itself may be truncated, so this line
      // cannot claim an exact remainder — "+2043 more commits" would contradict
      // the header's "2048+" and assert a total we cannot know (#15).
      lines.push(
        commits.length >= MAX_PUSH_COMMITS
          ? `_+${overflow} more commits; the push may contain more_`
          : `_+${overflow} more commit${overflow === 1 ? "" : "s"}_`,
      );
    }
    elements.push(markdown(lines.join("\n")));
  }

  if (body) elements.push(markdown(body));

  // A deleted branch's `after` sha is all zeros, so a compare link would lead
  // nowhere.
  if (compare && !deleted) elements.push(linkButton("Compare changes", compare));

  const badges: HeaderBadge[] = [{ text: "push", color: "blue" }];
  if (forced) badges.push({ text: "force push", color: "red" });
  if (deleted) badges.push({ text: "branch deleted", color: "red" });
  if (created) badges.push({ text: "new branch", color: "green" });

  return {
    header: {
      title: deleted ? "🌿 branch deleted" : `📦 ${totalLabel} pushed`,
      subtitle: branch ? `${repo} › ${branch}` : repo,
      // Red for a history rewrite: it is the one push kind that can destroy
      // work, so it must not look like an ordinary push.
      template: forced ? "red" : "blue",
      badges,
    },
    elements,
  };
}

/**
 * Map a PR/issue action to a colored badge.
 *
 * The palette is governed by one rule: an action the reader may need to *act
 * on* gets a colour of its own, and routine churn stays `neutral` so it can
 * never be mistaken for a signal. (Tag colours are a small finite enum, so
 * pairwise distinguishability across every action is not the goal — telling
 * "needs attention" apart from "noise" is.)
 */
function actionBadge(action: string): HeaderBadge {
  const map: Record<string, TagColor> = {
    // Activation / progress.
    opened: "turquoise",
    reopened: "green",
    created: "wathet",
    ready_for_review: "blue",
    published: "turquoise",
    released: "turquoise",
    prereleased: "yellow",
    // Terminal or destructive.
    closed: "red",
    deleted: "red",
    unpublished: "red",
    merged: "violet",
    // Needs the reader to act.
    review_requested: "orange",
    assigned: "indigo",
    converted_to_draft: "yellow",
    transferred: "carmine",
    renamed: "purple",
    publicized: "red",
    // Routine churn — deliberately neutral.
    synchronize: "neutral",
    labeled: "neutral",
    unlabeled: "neutral",
    unassigned: "neutral",
    review_request_removed: "neutral",
    milestoned: "neutral",
    demilestoned: "neutral",
    edited: "neutral",
    updated: "neutral",
    locked: "neutral",
    unlocked: "neutral",
    pinned: "neutral",
    unpinned: "neutral",
    auto_merge_enabled: "neutral",
    auto_merge_disabled: "neutral",
  };
  return { text: action, color: map[action] ?? "neutral" };
}

/**
 * Header colour for a pull request.
 *
 * Merged and closed-without-merging must not look like an open PR (#15). The
 * issues card already varies its header by action; these two builders should
 * agree on that.
 */
function prHeaderColor(action: string, merged: boolean): CardColor {
  if (merged) return "violet";
  if (action === "closed") return "grey";
  return "purple";
}

function buildPullRequestCard(message: EventMessage, body: string): FeishuCard {
  const p = message.payload;
  const repo = message.repository.full_name;
  const repoUrl = message.repository.html_url;
  const number = asNum(p.number);
  const action = message.action ?? asStr(p.action) ?? "updated";
  const pr = asObj(p.pull_request);
  const title = asStr(pr.title) ?? "(untitled)";
  const prUrl = asStr(pr.html_url) ?? repoUrl;
  const prBody = truncate(asStr(pr.body), 300);
  const user = asStr(asObj(pr.user).login) ?? message.actor.login;
  const additions = asNum(pr.additions);
  const deletions = asNum(pr.deletions);
  const changedFiles = asNum(pr.changed_files);
  const headRef = asStr(asObj(pr.head).ref);
  const baseRef = asStr(asObj(pr.base).ref);
  const merged = Boolean(pr.merged);
  const draft = Boolean(pr.draft);
  const labels = asArr(pr.labels)
    .map((l) => asStr(asObj(l).name))
    .filter(Boolean) as string[];

  const elements: CardElement[] = [];
  elements.push(markdown(`### ${md(title)}`));
  if (prBody) elements.push(markdown(`> ${md(prBody).replace(/\n/g, "\n> ")}`));
  if (body) elements.push(markdown(body));

  // Info row: author + branch flow | colored +/-/files stats.
  const leftLines = [`👤 **${md(user)}**`];
  // Branch names are user-supplied and git allows `<` / `>` in a ref name.
  if (headRef && baseRef) leftLines.push(`🔀 \`${md(headRef)}\` → \`${md(baseRef)}\``);
  const rightLines: string[] = [];
  if (additions !== undefined) rightLines.push(colored("green", `+${additions}`));
  if (deletions !== undefined) rightLines.push(colored("red", `-${deletions}`));
  if (changedFiles !== undefined) rightLines.push(`📁 ${changedFiles} file${changedFiles === 1 ? "" : "s"}`);
  elements.push(hr());
  elements.push(columnSet([[markdown(leftLines.join("\n"))], [markdown(rightLines.join("  "))]]));
  // Issues have always shown their labels; PRs showed none at all, for the same
  // repository concept (#17).
  if (labels.length > 0) elements.push(markdown(renderLabels(labels)));

  elements.push(buttonRow(
    { label: "View PR", url: prUrl, type: "primary" },
    { label: "View files", url: `${prUrl}/files`, type: "default" },
  ));

  const badges: HeaderBadge[] = [actionBadge(action)];
  if (merged) badges.push({ text: "merged", color: "violet" });
  if (draft) badges.push({ text: "draft", color: "neutral" });

  return {
    header: {
      title: `🔀 PR #${number ?? "?"}`,
      subtitle: repo,
      template: prHeaderColor(action, merged),
      badges,
    },
    elements,
  };
}

function buildIssuesCard(message: EventMessage, body: string): FeishuCard {
  const p = message.payload;
  const repo = message.repository.full_name;
  const repoUrl = message.repository.html_url;
  // GitHub's `issues` webhook nests the number under `issue.number` (unlike
  // `pull_request`, which has a top-level `number`). Read both for safety.
  const number = asNum(asObj(p.issue).number) ?? asNum(p.number);
  const action = message.action ?? asStr(p.action) ?? "updated";
  const issue = asObj(p.issue);
  const title = asStr(issue.title) ?? "(untitled)";
  const issueUrl = asStr(issue.html_url) ?? repoUrl;
  const issueBody = truncate(asStr(issue.body), 300);
  const user = asStr(asObj(issue.user).login) ?? message.actor.login;
  const labels = asArr(issue.labels).map((l) => asStr(asObj(l).name)).filter(Boolean) as string[];

  const elements: CardElement[] = [];
  elements.push(markdown(`### ${md(title)}`));
  if (issueBody) elements.push(markdown(`> ${md(issueBody).replace(/\n/g, "\n> ")}`));
  if (body) elements.push(markdown(body));

  // Info row: author | labels. When there are no labels, render the author
  // full-width instead of an empty label column.
  elements.push(hr());
  if (labels.length > 0) {
    elements.push(columnSet([
      [markdown(`👤 **${md(user)}**`)],
      [markdown(renderLabels(labels))],
    ]));
  } else {
    elements.push(markdown(`👤 **${md(user)}**`));
  }

  elements.push(linkButton("View Issue", issueUrl));

  return {
    header: {
      title: `📌 Issue #${number ?? "?"}`,
      subtitle: repo,
      template: action === "closed" ? "green" : action === "reopened" ? "turquoise" : "orange",
      badges: [actionBadge(action)],
    },
    elements,
  };
}

function buildReleaseCard(message: EventMessage, body: string): FeishuCard {
  const p = message.payload;
  const repo = message.repository.full_name;
  const repoUrl = message.repository.html_url;
  const release = asObj(p.release);
  const name = asStr(release.name) ?? asStr(release.tag_name) ?? "release";
  const tag = asStr(release.tag_name) ?? "";
  const releaseUrl = asStr(release.html_url) ?? repoUrl;
  const relBody = truncate(asStr(release.body), 600);
  const author = asStr(asObj(release.author).login) ?? message.actor.login;
  const prerelease = Boolean(release.prerelease);
  const assetCount = asArr(release.assets).length;

  const elements: CardElement[] = [];
  elements.push(markdown(`### ${md(name)}`));
  if (relBody) elements.push(markdown(md(relBody)));
  if (body) elements.push(markdown(body));

  elements.push(hr());
  const rightLines = [`👤 **${md(author)}**`];
  if (assetCount > 0) rightLines.push(`📦 ${assetCount} asset${assetCount === 1 ? "" : "s"}`);
  elements.push(markdown(rightLines.join("\n")));

  elements.push(linkButton("View Release", releaseUrl));

  const badges: HeaderBadge[] = [];
  if (tag) badges.push({ text: tag, color: "neutral" });
  if (prerelease) badges.push({ text: "prerelease", color: "yellow" });

  return {
    header: {
      title: `🏷️ Release ${tag}`.trim(),
      subtitle: repo,
      template: prerelease ? "yellow" : "turquoise",
      badges,
    },
    elements,
  };
}

function buildStarCard(message: EventMessage, body: string): FeishuCard {
  const repo = message.repository.full_name;
  const repoUrl = message.repository.html_url;
  const actor = message.actor.login;
  const action = message.action ?? "created";
  const verb = action === "deleted" ? "unstarred" : "starred";

  const elements: CardElement[] = [
    markdown(`**${md(actor)}** ${verb} ⭐ ${maybeLink(repo, repoUrl)}`),
  ];
  if (body) elements.push(markdown(body));
  elements.push(linkButton("View Repo", repoUrl, "default"));

  return {
    header: { title: `⭐ ${verb}`, subtitle: repo, template: "wathet" },
    elements,
  };
}

function buildForkCard(message: EventMessage, body: string): FeishuCard {
  const repo = message.repository.full_name;
  const repoUrl = message.repository.html_url;
  const actor = message.actor.login;
  const forkee = asObj(message.payload.forkee);
  const forkeeUrl = asStr(forkee.html_url);
  const forkeeName = asStr(forkee.full_name) ?? "a fork";

  const elements: CardElement[] = [
    markdown(`**${md(actor)}** forked 🍴\n${maybeLink(repo, repoUrl)} → ${maybeLink(forkeeName, forkeeUrl ?? repoUrl)}`),
  ];
  if (body) elements.push(markdown(body));
  // The body reads "A → B(fork)", so the button has to open the fork. It used
  // to point at the upstream repo, making the button and the text disagree
  // (#17). Without a forkee url there is no fork to open, so it falls back to
  // the upstream repo and says so.
  elements.push(
    linkButton(forkeeUrl ? "View Fork" : "View Repo", forkeeUrl ?? repoUrl, "default"),
  );

  return {
    header: { title: `🍴 forked`, subtitle: repo, template: "wathet" },
    elements,
  };
}

function buildFallbackCard(message: EventMessage, body: string): FeishuCard {
  const p = message.payload;
  const repo = message.repository.full_name;
  const repoUrl = message.repository.html_url;
  // Discriminate repo-scoped vs org-scoped by whether the RAW payload has a
  // top-level `repository`. (Repo events on an org-owned repo ALSO carry an
  // `organization` field, so checking `organization` is wrong — it mislabels
  // repo events as "View Org". See #13.)
  const hasRepository = p.repository !== undefined && p.repository !== null;

  // Build a richer body than just "event · action": surface comment content,
  // the parent issue/PR title+number, and org/member details when present.
  const lines: string[] = [];
  lines.push(`**${md(message.event)}**${message.action ? ` · ${md(message.action)}` : ""}`);

  // Comment-bearing events: issue_comment / commit_comment / discussion /
  // discussion_comment all nest a `comment` (or `discussion`) with a body.
  const comment = asObj(p.comment);
  const commentBody = truncate(asStr(comment.body), 300);
  // The parent issue/PR for issue_comment.
  const issue = asObj(p.issue);
  const issueTitle = asStr(issue.title);
  const issueNumber = asNum(issue.number);
  const discussion = asObj(p.discussion);
  const discussionTitle = asStr(discussion.title);

  if (issueTitle) {
    lines.push(`### ${md(issueTitle)}${issueNumber !== undefined ? ` #${issueNumber}` : ""}`);
  } else if (discussionTitle) {
    lines.push(`### ${md(discussionTitle)}`);
  }
  if (commentBody) {
    lines.push(`> ${md(commentBody).replace(/\n/g, "\n> ")}`);
  }

  // Who the event is about. Only an event that is *not* about a person may name
  // the actor — otherwise the card asserts something the payload never said
  // (#17).
  const subject = resolveEventSubject(message.event, message.action, p);
  const details = resolveMembershipDetails(p);
  if (subject.kind === "login") {
    const who = subject.htmlUrl
      ? `[${md(subject.login)}](${subject.htmlUrl})`
      : `**${md(subject.login)}**`;
    const role = details.role ? ` · \`${md(details.role)}\`` : "";
    const state = details.state ? ` · ${md(details.state)}` : "";
    lines.push(`👤 ${who}${role}${state}`);
  } else if (subject.kind === "email-invite") {
    // Deliberately not the address — see `resolveEventSubject`.
    lines.push("👤 a user invited by email");
  } else if (subject.kind === "unnamed") {
    lines.push("👤 unknown");
  } else {
    lines.push(`👤 **${md(message.actor.login)}**`);
  }
  if (details.inviterLogin) {
    lines.push(`✉️ invited by **${md(details.inviterLogin)}**`);
  }
  if (details.teamName) {
    lines.push(`🏷️ team ${maybeLink(details.teamName, details.teamUrl)}`);
  }
  if (details.previousPermission) {
    // Only the previous value exists in the payload, so this must not read as
    // the current permission.
    lines.push(`⚠️ permission changed (previously \`${md(details.previousPermission)}\`)`);
  }
  const orgLogin = asStr(asObj(p.organization).login);
  if (orgLogin && !hasRepository) {
    lines.push(`🏢 ${md(orgLogin)}`);
  }
  // Compose rather than replace. `lines` is this card's own rendering of the
  // event — comment text, parent issue/PR title, membership details — and a
  // configured template adds complementary content on top of it, which is the
  // relationship every other builder has with `body`. Letting `body` win
  // discarded everything above, so configuring a template made this card *less*
  // informative than leaving it unset (#16).
  const content = [lines.join("\n"), body]
    .filter((part) => part.length > 0)
    .join("\n\n");

  const elements: CardElement[] = [markdown(content)];
  // Only emit a button when there is a real URL — a dead button does nothing
  // when clicked (#6).
  const link = resolvePrimaryLink(p, repoUrl);
  if (link) elements.push(linkButton(link.label, link.url, "default"));

  return {
    header: {
      title: `📋 ${message.event}`,
      subtitle: repo,
      template: "grey",
      // Route the fallback's badge through the same palette every other card
      // uses, so an action like `publicized` or `transferred` is not flattened
      // to neutral just because this event lacks a dedicated builder (#15).
      badges: message.action ? [actionBadge(message.action)] : undefined,
    },
    elements,
  };
}

/**
 * Build a rich Feishu card for the given event, dispatching on event type.
 *
 * @param message  the rendered event. `formatted.body` carries the configured
 *                 template's markdown — possibly empty — and is folded in as
 *                 extra content.
 */
export function buildCard(message: EventMessage): FeishuCard {
  const body = message.formatted?.body ?? "";
  switch (message.event) {
    case "push":
      return buildPushCard(message, body);
    case "pull_request":
      return buildPullRequestCard(message, body);
    case "issues":
      return buildIssuesCard(message, body);
    case "release":
      return buildReleaseCard(message, body);
    case "star":
      return buildStarCard(message, body);
    case "fork":
      return buildForkCard(message, body);
    default:
      return buildFallbackCard(message, body);
  }
}
