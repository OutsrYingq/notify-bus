import { describe, expect, it } from "bun:test";
import { buildCard } from "./feishu-cards";
import { renderFormatted } from "../render";
import { findTemplate, loadSeedConfig } from "../config";
import type { EventMessage } from "../../types";

/** Minimal EventMessage with a raw GitHub-shaped payload + optional formatted body. */
function msg(
  event: string,
  payload: Record<string, unknown>,
  opts: { action?: string; formattedBody?: string; ref?: string } = {},
): EventMessage {
  return {
    id: "evt-1",
    event,
    action: opts.action,
    ref: opts.ref,
    repository: { full_name: "org/repo", html_url: "https://github.com/org/repo" },
    actor: { login: "alice", avatar_url: "https://gh/alice.png" },
    payload,
    metadata: {},
    formatted: opts.formattedBody
      ? { title: "t", body: opts.formattedBody }
      : undefined,
  };
}

/** Recursively collect button open_url destinations from elements + columns. */
function findButtonUrls(elements: unknown[]): string[] {
  const urls: string[] = [];
  for (const el of elements) {
    const tag = (el as { tag?: string }).tag;
    if (tag === "button") {
      const behaviors = (el as { behaviors?: { default_url?: string }[] }).behaviors ?? [];
      for (const b of behaviors) if (b.default_url) urls.push(b.default_url);
    }
    if (tag === "column_set") {
      for (const col of (el as { columns?: { elements?: unknown[] }[] }).columns ?? []) {
        urls.push(...findButtonUrls((col.elements ?? []) as unknown[]));
      }
    }
  }
  return urls;
}

/** Stringify a card's elements (recursing into column_set columns) so we can
 * grep for inline markup like <font> and <text_tag>. */
function elementMarkdown(elements: unknown[]): string {
  const out: string[] = [];
  const walk = (els: unknown[]): void => {
    for (const el of els) {
      const tag = (el as { tag?: string }).tag;
      if (tag === "markdown") {
        const content = (el as { content?: string }).content;
        if (typeof content === "string") out.push(content);
      } else if (tag === "div") {
        const text = (el as { text?: { content?: string } }).text;
        if (text?.content) out.push(text.content);
        for (const f of (el as { fields?: { text?: { content?: string } }[] }).fields ?? []) {
          if (f.text?.content) out.push(f.text.content);
        }
      } else if (tag === "column_set") {
        for (const col of (el as { columns?: { elements?: unknown[] }[] }).columns ?? []) {
          walk((col.elements ?? []) as unknown[]);
        }
      }
    }
  };
  walk(elements);
  return out.join("\n");
}

describe("buildCard · push", () => {
  const card = buildCard(
    msg(
      "push",
      {
        ref: "refs/heads/main",
        compare: "https://github.com/org/repo/compare/abc...def",
        pusher: { name: "alice" },
        commits: [
          { id: "0123456789abcdef", message: "fix: login\n\n细节", author: { name: "Alice" } },
          { id: "fedcba9876543210", message: "docs: readme", author: { name: "Alice", username: "alice" } },
        ],
        head_commit: { added: ["a.ts"], modified: ["b.ts", "c.ts"], removed: ["d.ts"] },
      },
      { ref: "refs/heads/main" },
    ),
  );

  it("uses a blue header with subtitle and a 'push' badge", () => {
    expect(card.header.template).toBe("blue");
    expect(card.header.title).toContain("2 commits pushed");
    expect(card.header.subtitle).toContain("org/repo");
    expect(card.header.subtitle).toContain("main");
    expect(card.header.badges?.[0]).toEqual({ text: "push", color: "blue" });
  });

  it("lists commits with short shas, capped at 5, with author pills", () => {
    const text = elementMarkdown(card.elements);
    expect(text).toContain("`0123456`");
    expect(text).toContain("fix: login");
    expect(text).toContain('<text_tag color="neutral">Alice');
  });

  it("shows colored file stats (+green / ~orange / -red)", () => {
    const text = elementMarkdown(card.elements);
    expect(text).toContain('<font color="green">+1</font>');
    expect(text).toContain('<font color="orange">~2</font>');
    expect(text).toContain('<font color="red">-1</font>');
  });

  it("includes the compare button", () => {
    expect(findButtonUrls(card.elements)).toContain(
      "https://github.com/org/repo/compare/abc...def",
    );
  });

  it("notes the overflow with '+N more commits'", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `sha${i}000000`,
      message: `commit ${i}`,
      author: { name: "Alice" },
    }));
    const c = buildCard(msg("push", { ref: "refs/heads/x", commits: many }, { ref: "refs/heads/x" }));
    expect(elementMarkdown(c.elements)).toContain("+3 more commits");
  });
});

describe("buildCard · push · push state (#15)", () => {
  it("counts the commits array — the only count the payload carries", () => {
    // The webhook push payload has no total-count field. `total_commits` is not
    // a GitHub field (it exists on other forges) and `size`/`distinct_size`
    // appear only on the Events API; the 13 real top-level fields are
    // after/base_ref/before/commits/compare/created/deleted/forced/head_commit/
    // pusher/ref/repository/sender. Per GitHub's docs `commits` is capped at
    // 2048 entries, so its length is the push size for any realistic push.
    const commits = Array.from({ length: 7 }, (_, i) => ({
      id: `sha${i}000000`,
      message: `commit ${i}`,
      author: { name: "Alice" },
    }));
    const card = buildCard(
      msg("push", { ref: "refs/heads/main", commits }, { ref: "refs/heads/main" }),
    );
    expect(card.header.title).toBe("📦 7 commits pushed");
    expect(elementMarkdown(card.elements)).toContain("📦 7 commits");
  });

  it("does not assert an exact count when the commits array is at GitHub's cap", () => {
    // A 2048-entry array may be exactly 2048 commits or a longer push that
    // GitHub truncated, so the card must not claim "2048".
    const commits = Array.from({ length: 2048 }, (_, i) => ({
      id: `sha${i}000000`,
      message: `commit ${i}`,
      author: { name: "Alice" },
    }));
    const card = buildCard(
      msg("push", { ref: "refs/heads/main", commits }, { ref: "refs/heads/main" }),
    );
    expect(card.header.title).toBe("📦 2048+ commits pushed");
  });

  it("uses the singular for a one-commit push", () => {
    const card = buildCard(
      msg("push", { ref: "refs/heads/main", commits: [{ id: "abcdefg1234", message: "one" }] }, { ref: "refs/heads/main" }),
    );
    expect(card.header.title).toBe("📦 1 commit pushed");
  });

  it("visibly marks a force push", () => {
    const card = buildCard(
      msg(
        "push",
        { ref: "refs/heads/main", forced: true, commits: [{ id: "abc1234567", message: "rewritten" }] },
        { ref: "refs/heads/main" },
      ),
    );
    expect(card.header.badges).toContainEqual({ text: "force push", color: "red" });
    expect(card.header.template).toBe("red");
  });

  it("reports a deleted branch instead of '0 commits pushed'", () => {
    // GitHub really sends `deleted: true` together with an empty `commits` array
    // and a null `head_commit` — its own published push payload example is a
    // branch deletion.
    const card = buildCard(
      msg("push", { ref: "refs/heads/old", deleted: true, commits: [], head_commit: null }, { ref: "refs/heads/old" }),
    );
    expect(card.header.title).toBe("🌿 branch deleted");
    expect(card.header.badges).toContainEqual({ text: "branch deleted", color: "red" });
    expect(elementMarkdown(card.elements)).not.toContain("0 commits");
  });

  it("does not offer a Compare link for a deleted branch", () => {
    // A deleted branch's `after` sha is all zeros, so the target is meaningless.
    const compare = "https://github.com/org/repo/compare/aaa...000";
    const card = buildCard(
      msg("push", { ref: "refs/heads/old", deleted: true, commits: [], compare }, { ref: "refs/heads/old" }),
    );
    expect(findButtonUrls(card.elements)).not.toContain(compare);
  });

  it("marks a branch created by the push", () => {
    const card = buildCard(
      msg(
        "push",
        { ref: "refs/heads/new", created: true, commits: [{ id: "abc1234567", message: "init" }] },
        { ref: "refs/heads/new" },
      ),
    );
    expect(card.header.badges).toContainEqual({ text: "new branch", color: "green" });
  });

  it("leaves an ordinary push marked only as a push", () => {
    const card = buildCard(
      msg("push", { ref: "refs/heads/main", commits: [{ id: "abc1234567", message: "a" }] }, { ref: "refs/heads/main" }),
    );
    expect(card.header.badges).toEqual([{ text: "push", color: "blue" }]);
    expect(card.header.template).toBe("blue");
  });
});

describe("buildCard · pull_request", () => {
  const card = buildCard(
    msg(
      "pull_request",
      {
        action: "opened",
        number: 42,
        pull_request: {
          title: "Add login",
          html_url: "https://github.com/org/repo/pull/42",
          body: "implements the thing",
          user: { login: "bob" },
          head: { ref: "feature/x" },
          base: { ref: "main" },
          additions: 42,
          deletions: 7,
          changed_files: 3,
          merged: false,
        },
      },
      { action: "opened" },
    ),
  );

  it("uses a purple header with PR number, an action badge", () => {
    expect(card.header.template).toBe("purple");
    expect(card.header.title).toBe("🔀 PR #42");
    expect(card.header.badges?.[0]).toEqual({ text: "opened", color: "turquoise" });
  });

  it("renders colored additions/deletions/files stats", () => {
    const text = elementMarkdown(card.elements);
    expect(text).toContain('<font color="green">+42</font>');
    expect(text).toContain('<font color="red">-7</font>');
    expect(text).toContain("3 files");
  });

  it("renders the branch flow head → base", () => {
    expect(elementMarkdown(card.elements)).toContain("`feature/x` → `main`");
  });

  it("links View PR + View files buttons", () => {
    const urls = findButtonUrls(card.elements);
    expect(urls).toContain("https://github.com/org/repo/pull/42");
    expect(urls).toContain("https://github.com/org/repo/pull/42/files");
  });

  it("uses violet + merged badge when merged", () => {
    const merged = buildCard(
      msg(
        "pull_request",
        {
          action: "closed",
          number: 9,
          pull_request: { title: "t", html_url: "u", user: { login: "x" }, merged: true },
        },
        { action: "closed" },
      ),
    );
    expect(merged.header.template).toBe("violet");
    expect(merged.header.badges?.some((b) => b.text === "merged")).toBe(true);
  });

  it("puts the body in a blockquote", () => {
    expect(elementMarkdown(card.elements)).toContain("> implements the thing");
  });
});

describe("buildCard · pull_request header reflects the action (#15)", () => {
  const prCard = (action: string, extra: Record<string, unknown> = {}) =>
    buildCard(
      msg(
        "pull_request",
        { action, number: 1, pull_request: { title: "t", html_url: "u", user: { login: "x" }, ...extra } },
        { action },
      ),
    );

  it("keeps an open PR purple", () => {
    expect(prCard("opened").header.template).toBe("purple");
  });

  it("uses violet when merged", () => {
    expect(prCard("closed", { merged: true }).header.template).toBe("violet");
  });

  it("does not render a closed-without-merge PR like an open one", () => {
    const closed = prCard("closed");
    const opened = prCard("opened");
    expect(closed.header.template).toBe("grey");
    expect(closed.header.template).not.toBe(opened.header.template);
  });
});

describe("buildCard · action badge palette (#15)", () => {
  /** Resolve an action's badge colour through the card that actually emits it. */
  function badgeColor(event: string, action: string): string | undefined {
    const payload: Record<string, unknown> = { action, number: 1 };
    if (event === "pull_request") {
      payload.pull_request = { title: "t", html_url: "u", user: { login: "x" } };
    }
    return buildCard(msg(event, payload, { action })).header.badges?.[0]?.color;
  }

  it("applies the palette on the fallback card, not only the dedicated builders", () => {
    // Events without a dedicated builder go through buildFallbackCard, which
    // used to hardcode a neutral badge — silently disabling the palette for the
    // ~30 event types that have no builder of their own. The `repository`
    // rows above cover this too; this test exists so the coverage is explicit
    // and cannot be lost by editing that table.
    const card = buildCard(msg("repository", { action: "transferred" }, { action: "transferred" }));
    // header `grey` is buildFallbackCard's signature — assert it so this test
    // cannot silently start exercising a different builder.
    expect(card.header.template).toBe("grey");
    expect(card.header.badges).toContainEqual({ text: "transferred", color: "carmine" });
  });

  it("gives an action the reader may need to act on a colour of its own", () => {
    const actionable: [string, string, string][] = [
      ["pull_request", "opened", "turquoise"],
      ["pull_request", "reopened", "green"],
      ["pull_request", "closed", "red"],
      ["pull_request", "ready_for_review", "blue"],
      ["pull_request", "review_requested", "orange"],
      ["pull_request", "assigned", "indigo"],
      ["pull_request", "converted_to_draft", "yellow"],
      ["repository", "transferred", "carmine"],
      ["repository", "renamed", "purple"],
      ["repository", "publicized", "red"],
    ];
    for (const [event, action, color] of actionable) {
      expect([event, action, badgeColor(event, action)]).toEqual([event, action, color]);
    }
  });

  it("keeps routine churn neutral so it cannot read as a signal", () => {
    const churn = [
      "synchronize",
      "labeled",
      "unlabeled",
      "unassigned",
      "review_request_removed",
      "milestoned",
      "demilestoned",
      "edited",
      "updated",
      "locked",
      "unlocked",
      "pinned",
    ];
    for (const action of churn) {
      expect([action, badgeColor("pull_request", action)]).toEqual([action, "neutral"]);
    }
  });

  it("falls back to neutral for an action it does not know", () => {
    expect(badgeColor("pull_request", "some_future_action")).toBe("neutral");
  });
});

describe("buildCard · issues", () => {
  it("is orange when opened, green when closed, with action badges", () => {
    const opened = buildCard(
      msg("issues", {
        action: "opened",
        number: 7,
        issue: {
          title: "Bug",
          html_url: "https://github.com/org/repo/issues/7",
          body: "it broke",
          user: { login: "carol" },
          state: "open",
          labels: [{ name: "bug" }, { name: "ui" }],
        },
      }, { action: "opened" }),
    );
    expect(opened.header.template).toBe("orange");
    expect(opened.header.badges?.[0]).toEqual({ text: "opened", color: "turquoise" });
    expect(findButtonUrls(opened.elements)).toContain("https://github.com/org/repo/issues/7");

    const closed = buildCard(
      msg("issues", {
        action: "closed",
        number: 7,
        issue: { title: "Bug", html_url: "u", user: { login: "c" }, state: "closed" },
      }, { action: "closed" }),
    );
    expect(closed.header.template).toBe("green");
    expect(closed.header.badges?.[0]).toEqual({ text: "closed", color: "red" });
  });

  it("renders labels as colored text_tag pills", () => {
    const card = buildCard(
      msg("issues", {
        action: "opened",
        number: 1,
        issue: {
          title: "t",
          html_url: "u",
          user: { login: "c" },
          labels: [{ name: "bug" }, { name: "enhancement" }],
        },
      }, { action: "opened" }),
    );
    const text = elementMarkdown(card.elements);
    expect(text).toContain('<text_tag color="blue">bug</text_tag>');
    expect(text).toContain('<text_tag color="turquoise">enhancement</text_tag>');
  });

  it("reads the issue number from payload.issue.number (not top-level)", () => {
    // Real `issues` webhook payloads nest the number under `issue.number`,
    // with NO top-level `number`. Regression for the '#?' bug (#8).
    const card = buildCard(
      msg("issues", {
        action: "opened",
        issue: {
          number: 42,
          title: "Something broke",
          html_url: "https://github.com/org/repo/issues/42",
          user: { login: "carol" },
        },
      }, { action: "opened" }),
    );
    expect(card.header.title).toBe("📌 Issue #42");
  });

  it("does not render a label column when the issue has no labels", () => {
    const card = buildCard(
      msg("issues", {
        action: "opened",
        issue: {
          number: 5,
          title: "No labels here",
          html_url: "u",
          user: { login: "c" },
          labels: [],
        },
      }, { action: "opened" }),
    );
    const text = elementMarkdown(card.elements);
    expect(text).not.toContain("🏷️");
    // Author still present.
    expect(text).toContain("👤");
  });
});

describe("buildCard · release", () => {
  it("is turquoise, with tag + author + button", () => {
    const card = buildCard(
      msg("release", {
        action: "published",
        release: {
          name: "v1.0.0",
          tag_name: "v1.0.0",
          html_url: "https://github.com/org/repo/releases/tag/v1.0.0",
          body: "## What's new\n- stuff",
          author: { login: "dave" },
          prerelease: false,
          assets: [{ name: "a.zip" }, { name: "b.zip" }],
        },
      }, { action: "published" }),
    );
    expect(card.header.template).toBe("turquoise");
    expect(card.header.badges?.[0]).toEqual({ text: "v1.0.0", color: "neutral" });
    expect(elementMarkdown(card.elements)).toContain("2 assets");
    expect(findButtonUrls(card.elements)).toContain("https://github.com/org/repo/releases/tag/v1.0.0");
  });

  it("is yellow + prerelease badge for a prerelease", () => {
    const card = buildCard(
      msg("release", {
        action: "prereleased",
        release: { name: "v2-beta", tag_name: "v2.0.0-beta", html_url: "u", author: { login: "d" }, prerelease: true },
      }, { action: "prereleased" }),
    );
    expect(card.header.template).toBe("yellow");
    expect(card.header.badges?.some((b) => b.text === "prerelease")).toBe(true);
  });
});

describe("buildCard · star / fork", () => {
  it("star is wathet, links repo via button", () => {
    const card = buildCard(msg("star", { action: "created" }, { action: "created" }));
    expect(card.header.template).toBe("wathet");
    expect(card.header.title).toContain("starred");
    expect(findButtonUrls(card.elements)).toContain("https://github.com/org/repo");
  });

  it("fork mentions the forkee name", () => {
    const card = buildCard(
      msg("fork", { forkee: { full_name: "eve/repo", html_url: "https://github.com/eve/repo" } }),
    );
    expect(card.header.template).toBe("wathet");
    expect(elementMarkdown(card.elements)).toContain("eve/repo");
  });
});

describe("buildCard · fallback", () => {
  it("renders a grey card for an unknown event with an action badge", () => {
    const card = buildCard(msg("deployment", { environment: "prod" }));
    expect(card.header.template).toBe("grey");
    expect(card.elements.length).toBeGreaterThan(0);
  });

  it("folds in the template-rendered body when provided", () => {
    const card = buildCard(msg("deployment", {}, { formattedBody: "**custom body**" }));
    expect(elementMarkdown(card.elements)).toContain("custom body");
  });

  it("surfaces membership.user + role for member events", () => {
    const card = buildCard(msg("member", {
      action: "added",
      membership: { role: "member", user: { login: "newperson", html_url: "https://github.com/newperson" } },
      organization: { login: "someorg" },
    }, { action: "added" }));
    const text = elementMarkdown(card.elements);
    expect(text).toContain("newperson");
    expect(text).toContain("`member`"); // role
    expect(text).toContain("someorg");
  });

  it("does not emit a button when the repo/org url is empty", () => {
    // Dead-button guard (#6): a button with an empty default_url does nothing.
    // Build a message whose repository.html_url is "" to exercise the guard.
    const emptyUrlMsg: EventMessage = {
      id: "e",
      event: "organization",
      action: "member_added",
      repository: { full_name: "someorg", html_url: "" },
      actor: { login: "someone", avatar_url: "" },
      payload: { action: "member_added", membership: { user: { login: "x" } }, organization: { login: "someorg" } },
      metadata: {},
    };
    const card = buildCard(emptyUrlMsg);
    expect(findButtonUrls(card.elements).length).toBe(0);
  });

  it("labels View Repo (not View Org) for a repo event whose repo belongs to an org (#13)", () => {
    // GitHub repo-scoped payloads include BOTH repository AND organization
    // when the repo is org-owned. Must not be misdetected as an org event.
    const card = buildCard(msg("issue_comment", {
      action: "created",
      repository: { full_name: "org/repo", html_url: "https://github.com/org/repo" },
      organization: { login: "org" },
    }, { action: "created" }));
    // No "View Org" label anywhere in the rendered button.
    const btns = card.elements.filter((e) => (e as { tag?: string }).tag === "button");
    for (const b of btns) {
      const content = (b as { text?: { content?: string } }).text?.content ?? "";
      expect(content).not.toBe("View Org");
    }
  });

  it("surfaces comment body + issue title/number for issue_comment (#13)", () => {
    const card = buildCard(msg("issue_comment", {
      action: "created",
      issue: { number: 42, title: "Login broken", html_url: "https://github.com/org/repo/issues/42" },
      comment: { body: "I can reproduce on Safari", html_url: "https://github.com/org/repo/issues/42#issuecomment-1" },
      repository: { full_name: "org/repo", html_url: "https://github.com/org/repo" },
    }, { action: "created" }));
    const text = elementMarkdown(card.elements);
    expect(text).toContain("Login broken");
    expect(text).toContain("#42");
    expect(text).toContain("I can reproduce on Safari");
    // Button links to the comment and is labeled "View Comment".
    const urls = findButtonUrls(card.elements);
    expect(urls).toContain("https://github.com/org/repo/issues/42#issuecomment-1");
  });

  it("labels View Org only for true org-scoped events (no repository in payload)", () => {
    // No `repository` key -> genuinely org-scoped -> "View Org".
    const card = buildCard(msg("organization", {
      action: "member_added",
      membership: { user: { login: "x" } },
      organization: { login: "someorg", html_url: "https://github.com/someorg" },
    }, { action: "member_added" }));
    // Note: msg() normalizes repository to org/repo; the discriminator is the
    // RAW payload.repository, which is absent here. Expect View Org label.
    const btn = card.elements.find((e) => (e as { tag?: string }).tag === "button");
    expect((btn as { text?: { content?: string } }).text?.content).toBe("View Org");
  });
});

describe("buildCard · no whole-card link", () => {
  it("never emits a cardLink (regression guard against re-adding card_link)", () => {
    const events = ["push", "pull_request", "issues", "release", "star", "fork", "deployment"];
    for (const e of events) {
      const c = buildCard(msg(e, e === "pull_request" ? { pull_request: { title: "t", html_url: "u", user: { login: "x" } } } : {}));
      expect((c as { cardLink?: unknown }).cardLink).toBeUndefined();
      expect("cardLink" in c).toBe(false);
    }
  });
});

describe("buildCard · schema correctness", () => {
  it("buttons use behaviors:[{type:'open_url',default_url}], not a top-level url", () => {
    const card = buildCard(
      msg("pull_request", {
        action: "opened",
        number: 1,
        pull_request: { title: "t", html_url: "https://x", user: { login: "y" } },
      }, { action: "opened" }),
    );
    for (const el of card.elements) {
      if ((el as { tag?: string }).tag !== "button") continue;
      expect((el as { behaviors?: unknown }).behaviors).toBeTypeOf("object");
      expect((el as { url?: unknown }).url).toBeUndefined();
    }
  });

  it("no element uses the removed v2 tags (action, note)", () => {
    const events = ["push", "pull_request", "issues", "release", "star", "fork", "unknown"];
    for (const e of events) {
      const card = buildCard(msg(e, e === "pull_request" ? { pull_request: { title: "t", html_url: "u", user: { login: "x" } } } : {}));
      for (const el of card.elements) {
        const tag = (el as { tag?: string }).tag;
        expect(tag).not.toBe("action");
        expect(tag).not.toBe("note");
      }
    }
  });
});

describe("buildCard · user text is not interpreted as card markup (#16)", () => {
  const AT = "<at id=all></at>";

  /** All markdown text in the card, concatenated. */
  const cardText = (message: EventMessage): string => elementMarkdown(buildCard(message).elements);

  const pushWith = (commitMessage: string, opts: { ref?: string; author?: string } = {}): EventMessage =>
    msg("push", {
      ref: opts.ref ?? "refs/heads/main",
      total_commits: 1,
      commits: [{ id: "abc1234567", message: commitMessage, author: { name: opts.author ?? "Alice" } }],
    }, { ref: opts.ref ?? "refs/heads/main" });

  it("escapes an <at> tag smuggled through a commit message", () => {
    const text = cardText(pushWith(AT));
    expect(text).not.toContain(AT);
    // Feishu's documented escaping form is the numeric entity, not `&lt;`.
    expect(text).toContain("&#60;at id=all&#62;");
  });

  it("escapes a smuggled <font> while leaving this module's own markup intact", () => {
    const text = cardText(pushWith("red<font color=green>greenagain</font>"));
    expect(text).not.toContain("<font color=green>greenagain");
    expect(text).toContain("&#60;font color=green&#62;greenagain");
    // The author pill this module generates is still a real tag.
    expect(text).toContain('<text_tag color="neutral">Alice</text_tag>');
  });

  it("escapes `<` in every payload field that reaches a markdown element", () => {
    const cases: [string, EventMessage][] = [
      ["commit.author.name", pushWith("ok", { author: AT })],
      ["pull_request.title", msg("pull_request", { action: "opened", number: 1, pull_request: { title: AT, html_url: "u", user: { login: "x" } } }, { action: "opened" })],
      ["pull_request.body", msg("pull_request", { action: "opened", number: 1, pull_request: { title: "t", html_url: "u", body: AT, user: { login: "x" } } }, { action: "opened" })],
      ["pull_request.head.ref", msg("pull_request", { action: "opened", number: 1, pull_request: { title: "t", html_url: "u", user: { login: "x" }, head: { ref: AT }, base: { ref: "main" } } }, { action: "opened" })],
      ["issue.title", msg("issues", { action: "opened", issue: { number: 1, title: AT, html_url: "u", user: { login: "c" } } }, { action: "opened" })],
      ["issue.body", msg("issues", { action: "opened", issue: { number: 1, title: "t", html_url: "u", body: AT, user: { login: "c" } } }, { action: "opened" })],
      ["issue.labels[].name", msg("issues", { action: "opened", issue: { number: 1, title: "t", html_url: "u", user: { login: "c" }, labels: [{ name: AT }] } }, { action: "opened" })],
      ["release.body", msg("release", { action: "published", release: { name: "v1", tag_name: "v1", html_url: "u", body: AT, author: { login: "d" } } }, { action: "published" })],
      ["comment.body", msg("issue_comment", { action: "created", issue: { number: 1, title: "t" }, comment: { body: AT, html_url: "u" } }, { action: "created" })],
      ["membership.role", msg("organization", { action: "member_added", membership: { role: AT, user: { login: "m" } }, organization: { login: "o" } }, { action: "member_added" })],
    ];
    for (const [field, message] of cases) {
      expect([field, cardText(message).includes(AT)]).toEqual([field, false]);
    }
  });

  it("escapes a smuggled tag in the branch name of a push", () => {
    const ref = `refs/heads/${AT}`;
    const text = cardText(msg("push", { ref, total_commits: 1, commits: [] }, { ref }));
    expect(text).not.toContain(AT);
  });
});

describe("buildCard · redundant elements are gone (#16)", () => {
  it("adds no footer note (the repo is already the header subtitle)", () => {
    const events = ["push", "pull_request", "issues", "release", "star", "fork", "deployment"];
    for (const event of events) {
      const card = buildCard(msg(event, event === "pull_request" ? { pull_request: { title: "t", html_url: "u", user: { login: "x" } } } : {}));
      const noteTexts = card.elements
        .filter((el) => (el as { tag?: string }).tag === "div")
        .map((el) => (el as { text?: { content?: string } }).text?.content ?? "");
      expect([event, noteTexts.some((t) => t.includes("notify-bus"))]).toEqual([event, false]);
    }
  });

  it("emits no whitespace-only element on the release card", () => {
    // The release card used to build a two-column layout whose right column was
    // a literal space, halving the author line's width for nothing. The empty
    // column is nested inside a column_set, so this walk has to recurse.
    const card = buildCard(
      msg("release", { action: "published", release: { name: "v1", tag_name: "v1", html_url: "u", author: { login: "d" } } }, { action: "published" }),
    );
    const contents: string[] = [];
    const walk = (els: unknown[]): void => {
      for (const el of els) {
        const e = el as { tag?: string; content?: string; columns?: { elements?: unknown[] }[] };
        if (typeof e.content === "string") contents.push(e.content);
        if (e.tag === "column_set") for (const col of e.columns ?? []) walk(col.elements ?? []);
      }
    };
    walk(card.elements);
    expect(contents.some((c) => c.trim() === "")).toBe(false);
  });
});

describe("renderFormatted -> buildCard (the production path, #16)", () => {
  it("keeps the fallback card's enriched content", () => {
    // Calling buildCard() directly cannot see this. renderFormatted always
    // populated formatted.body, and buildFallbackCard composes its body with
    // `body || lines` — so a non-empty default replaced, and therefore
    // discarded, everything #12/#13/#14 added to the fallback card.
    const message = msg("issue_comment", {
      action: "created",
      issue: { number: 42, title: "Login broken", html_url: "u" },
      comment: { body: "I can reproduce on Safari", html_url: "u#1" },
    }, { action: "created" });
    const text = elementMarkdown(buildCard(renderFormatted(message, undefined)).elements);
    expect(text).toContain("I can reproduce on Safari");
    expect(text).toContain("Login broken");
  });

  it("keeps membership details on the fallback card", () => {
    const message = msg("organization", {
      action: "member_added",
      membership: { role: "admin", user: { login: "NEW-MEMBER" } },
      organization: { login: "someorg" },
    }, { action: "member_added" });
    const text = elementMarkdown(buildCard(renderFormatted(message, undefined)).elements);
    expect(text).toContain("NEW-MEMBER");
    expect(text).toContain("admin");
  });

  it("keeps the fallback card's own content when a template IS configured", () => {
    // The fallback composed its body with `body || lines`, so a configured
    // template replaced — and therefore discarded — the comment text, parent
    // issue title and membership details. Configuring a template must not make
    // the card less informative than leaving it unset.
    const message = msg("issue_comment", {
      action: "created",
      issue: { number: 42, title: "Login broken", html_url: "u" },
      comment: { body: "I can reproduce on Safari", html_url: "u#1" },
    }, { action: "created" });
    const text = elementMarkdown(buildCard(renderFormatted(message, "Deploying now")).elements);
    expect(text).toContain("Login broken");
    expect(text).toContain("I can reproduce on Safari");
    expect(text).toContain("Deploying now");
  });

  it("ships no example template that re-renders a field the card already renders", () => {
    // config.example.yaml is what deployers copy. The cards build the payload
    // body themselves, so an example template re-rendering it would show that
    // body twice.
    const config = loadSeedConfig(`${import.meta.dir}/../../../../../config.example.yaml`);
    if (!config) throw new Error("config.example.yaml did not load");
    for (const event of ["push", "pull_request", "issues", "release"]) {
      expect([event, findTemplate(config, event)?.template]).toEqual([event, undefined]);
    }
  });

  it("renders the payload body exactly once when a template complements it", () => {
    const body = "This PR implements the login flow.";
    const message = msg("pull_request", {
      action: "opened",
      number: 1,
      pull_request: {
        title: "Add login",
        html_url: "u",
        body,
        user: { login: "bob" },
        requested_reviewers: [{ login: "carol" }],
      },
    }, { action: "opened" });
    // A template adding something the card does not render — here the requested
    // reviewers. Re-rendering `pull_request.body` would instead show it twice.
    const template =
      "Review requested from {{#each payload.pull_request.requested_reviewers}}{{login}}{{/each}}";
    const text = elementMarkdown(buildCard(renderFormatted(message, template)).elements);
    expect(text.split(body).length - 1).toBe(1);
    expect(text).toContain("Review requested from carol");
  });
});
