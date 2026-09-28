/**
 * `repository` card (#21) — the builder lives in
 * `feishu-repository-card.ts`, and these tests reach it the way production
 * does, through `buildCard`.
 */
import { describe, expect, it } from "bun:test";
import { buildCard } from "./feishu-cards";
import { renderFormatted } from "../render";
import {
  cardText,
  elementMarkdown,
  findRawButtons,
  msg,
  msgWithoutRepoUrl,
  prodCard,
} from "./feishu-card-test-helpers";

describe("buildCard · repository (#21)", () => {
  const REPO_URL = "https://github.com/org/repo";

  /** A GitHub-shaped `repository` payload; `extra` adds to the repository object. */
  const fixture = (
    action: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    action,
    repository: {
      name: "repo",
      full_name: "org/repo",
      html_url: REPO_URL,
      ...extra,
    },
    organization: { login: "org" },
  });

  it("is the quiet grey baseline for an ordinary edit", () => {
    const card = prodCard("repository", fixture("edited"), "edited");
    expect(card.header.template).toBe("grey");
    expect(card.header.badges).toEqual([{ text: "edited", color: "neutral" }]);
  });

  it("makes deleted and archived visibly different from an ordinary edit", () => {
    const template = (action: string) =>
      prodCard("repository", fixture(action), action).header.template;
    expect(template("deleted")).toBe("red");
    expect(template("archived")).toBe("yellow");
    expect(template("archived")).not.toBe(template("edited"));
    expect(template("deleted")).not.toBe(template("edited"));
  });

  it("shows the previous name on a rename, and no line at all without one", () => {
    const renamed = prodCard(
      "repository",
      {
        ...fixture("renamed"),
        changes: { repository: { name: { from: "old-name" } } },
      },
      "renamed",
    );
    expect(elementMarkdown(renamed.elements)).toContain("old-name");

    // A payload without the `changes` path degrades to no line (#21) — never to
    // "formerly undefined".
    const partial = prodCard("repository", fixture("renamed"), "renamed");
    expect(elementMarkdown(partial.elements)).not.toContain("undefined");
  });

  it("shows the previous owner on a transfer, and no line at all without one", () => {
    const transferred = prodCard(
      "repository",
      {
        ...fixture("transferred"),
        changes: { owner: { from: { user: { login: "old-owner" } } } },
      },
      "transferred",
    );
    expect(elementMarkdown(transferred.elements)).toContain("old-owner");

    const partial = prodCard("repository", fixture("transferred"), "transferred");
    expect(elementMarkdown(partial.elements)).not.toContain("undefined");
  });

  it("reads visibility from repository.private, never from repository.visibility", () => {
    // GitHub sends BOTH fields on a `privatized` payload, and `visibility` can
    // still hold the previous value — the fixtures make them disagree, so only
    // `private` can produce the right answer (#21).
    const privatized = prodCard(
      "repository",
      fixture("privatized", { private: true, visibility: "public" }),
      "privatized",
    );
    expect(elementMarkdown(privatized.elements)).toContain("private");
    expect(elementMarkdown(privatized.elements)).not.toContain("public");

    // The complement, so a card that simply echoed `private` verbatim could not
    // pass both: `visibility` says private while `private` says otherwise.
    const publicized = prodCard(
      "repository",
      fixture("publicized", { private: false, visibility: "private" }),
      "publicized",
    );
    expect(elementMarkdown(publicized.elements)).toContain("public");
    expect(elementMarkdown(publicized.elements)).not.toContain("private");
  });

  it("links the repository as its single default button", () => {
    const card = prodCard("repository", fixture("renamed"), "renamed");
    expect(findRawButtons(card.elements)).toEqual([
      { label: "View Repo", url: REPO_URL, type: "default" },
    ]);
  });

  it("emits no button when the repository has no url", () => {
    // `archived` deliberately, not `deleted`: that action drops the button for a
    // reason of its own (see below), and this test is about the empty-url guard.
    const noUrl = msgWithoutRepoUrl("repository", fixture("archived"), "archived");
    expect(findRawButtons(buildCard(noUrl).elements)).toEqual([]);
  });

  it("names the sender, since a repository event is not about a person", () => {
    const text = cardText("repository", fixture("edited"), "edited");
    expect(text).toContain("alice");
    expect(text).not.toContain("unknown");
  });

  it("appends a configured template beside the change it describes", () => {
    const message = msg(
      "repository",
      {
        ...fixture("renamed"),
        changes: { repository: { name: { from: "old-name" } } },
      },
      { action: "renamed" },
    );
    const text = elementMarkdown(
      buildCard(renderFormatted(message, "Please update your remotes")).elements,
    );
    expect(text).toContain("old-name");
    expect(text).toContain("Please update your remotes");
  });

  it("offers no button for a deleted repository, whose url no longer resolves", () => {
    // The payload still carries an `html_url`, but the repository that url
    // addresses is gone, so "View Repo" there is a dead link — the case #26's
    // guard and the push card's deleted-branch Compare link (#15) both rule
    // out. Asserted on the raw buttons so an empty target cannot pass as "no
    // button".
    const card = prodCard("repository", fixture("deleted"), "deleted");
    expect(findRawButtons(card.elements)).toEqual([]);
  });

  it("names an organization previous owner too", () => {
    // GitHub's documented `transferred` example uses the `user` owner shape;
    // an organization-owned previous owner carries the same `login` under
    // `organization`. Reading only `user` dropped this case silently.
    const transferred = prodCard(
      "repository",
      {
        ...fixture("transferred"),
        changes: { owner: { from: { organization: { login: "old-org" } } } },
      },
      "transferred",
    );
    expect(elementMarkdown(transferred.elements)).toContain("old-org");
  });

  it("is reached through buildCard, not the fallback", () => {
    // For `edited` the two cards are deliberately alike — grey header, the
    // action badge, one repository button — so the dispatch itself is pinned
    // here: the fallback titles itself `📋 repository`, this card `📦 edited`.
    expect(prodCard("repository", fixture("edited"), "edited").header.title).toBe("📦 edited");
  });
});
