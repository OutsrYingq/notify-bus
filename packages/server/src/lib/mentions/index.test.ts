/**
 * Mention parsing (#36).
 *
 * The rules are deliberately conservative: a mention that was not meant as one
 * must never become a Feishu @, and a login the channel does not map must never
 * become one either. Everything here is pure text and a map — no network, no
 * payload beyond the comment body.
 */
import { describe, expect, it } from "bun:test";
import {
  MAX_MENTIONS,
  commentBodyOf,
  mappedUserId,
  normalizeMentionMap,
  readMentionTargets,
  resolveMentionTargets,
} from "./index";
import type { EventMessage } from "../../types";

/**
 * A small team. `Bob` is written in mixed case on purpose, `og` is an old handle
 * for `alice` (one person, two logins), and `all` and `platform-team` are mapped
 * so the reserved-word and team-reference rules are tested against a login that
 * *would* match if they were read naively.
 */
const MAP = {
  alice: "ou_alice",
  og: "ou_alice",
  Bob: "ou_bob",
  carol: "ou_carol",
  dave: "ou_dave",
  erin: "ou_erin",
  frank: "ou_frank",
  all: "ou_all",
  "platform-team": "ou_platform",
};

const lookup = normalizeMentionMap(MAP);

/** A mapped author: the comment has to come from somebody the channel trusts. */
const AUTHOR = "carol";

function targets(
  text: string,
): { logins: readonly string[]; userIds: readonly string[] } | undefined {
  return resolveMentionTargets(text, lookup, AUTHOR);
}

describe("resolveMentionTargets", () => {
  it("matches a mapped login, whatever its case", () => {
    expect(targets("ping @alice please")).toEqual({ logins: ["alice"], userIds: ["ou_alice"] });
    expect(targets("ping @ALICE")).toEqual({ logins: ["alice"], userIds: ["ou_alice"] });
    expect(targets("ping @Bob")).toEqual({ logins: ["bob"], userIds: ["ou_bob"] });
    // …and the author's own login is compared the same way.
    expect(resolveMentionTargets("@alice", lookup, "CAROL")).toEqual({
      logins: ["alice"],
      userIds: ["ou_alice"],
    });
  });

  it("reads the map's own user id, ignoring case and padding", () => {
    expect(mappedUserId(lookup, "BOB")).toBe("ou_bob");
    expect(mappedUserId(lookup, " bob ")).toBe("ou_bob");
    expect(mappedUserId(lookup, "nobody")).toBeUndefined();
    expect(mappedUserId(lookup, undefined)).toBeUndefined();
  });

  it("mentions each person once, in the order the comment named them", () => {
    const result = targets("@alice look — @carol too, and @alice again");
    expect(result?.logins).toEqual(["alice", "carol"]);
    expect(result?.userIds).toEqual(["ou_alice", "ou_carol"]);
  });

  it("caps one card at MAX_MENTIONS people", () => {
    const text = ["alice", "bob", "carol", "dave", "erin", "frank"]
      .map((login) => `@${login}`)
      .join(" ");
    const result = targets(text);
    expect(MAX_MENTIONS).toBe(5);
    expect(result?.logins).toEqual(["alice", "bob", "carol", "dave", "erin"]);
    expect(result?.userIds).toHaveLength(MAX_MENTIONS);
  });

  it("ignores a mention inside a fenced code block", () => {
    expect(targets("try this\n```\n@alice deploy\n```\n")).toBeUndefined();
    expect(targets("~~~\n@alice\n~~~")).toBeUndefined();
  });

  it("ignores a mention inside inline code", () => {
    expect(targets("the log said `@alice failed` is all")).toBeUndefined();
    expect(targets("write `@alice` in the issue")).toBeUndefined();
  });

  it("ignores inline code written with a run of backticks", () => {
    // ` ``x`` ` is how a comment writes code that itself contains a backtick.
    expect(targets("the flag is ``--user=@alice`` here")).toBeUndefined();
  });

  it("ignores a fenced block of four backticks", () => {
    expect(targets("````\n@alice\n````")).toBeUndefined();
  });

  it("still reads the plain text around a code block", () => {
    expect(targets("```\n@bob\n```\nbut @alice please")?.logins).toEqual(["alice"]);
  });

  it("ignores a mention that continues into a longer login", () => {
    // `@alice_smith` names somebody else: a login cannot contain `_`, so the
    // token does not end there — and `@alice-bob` is one longer login, not two.
    expect(targets("@alice_smith please look")).toBeUndefined();
    expect(targets("@alice-bob please look")).toBeUndefined();
    // The punctuation a sentence actually ends with still terminates one.
    expect(targets("thanks @alice.")?.logins).toEqual(["alice"]);
    expect(targets("cc (@alice, @bob)")?.logins).toEqual(["alice", "bob"]);
  });

  it("ignores a mention written inside a URL", () => {
    // A link to somebody's profile is a reference, not an address.
    expect(targets("see https://example.com/@alice")).toBeUndefined();
    expect(targets("see example.com/@alice")).toBeUndefined();
  });

  it("ignores an escaped or doubled @", () => {
    expect(targets("write \\@alice to mention them")).toBeUndefined();
    expect(targets("@@alice")).toBeUndefined();
  });

  it("ignores an e-mail address that looks like a login", () => {
    expect(targets("mail alice@carol.com")).toBeUndefined();
    expect(targets("mail alice+review@dave.example")).toBeUndefined();
    expect(targets("mail alice.bob@erin.example")).toBeUndefined();
  });

  it("mentions a person once when two logins point at them", () => {
    // `og` is an old handle for alice: the same person, so one @ — and the cap
    // counts people rather than logins.
    expect(targets("@alice and @og")).toEqual({ logins: ["alice"], userIds: ["ou_alice"] });
    expect(targets("@alice @og @bob @carol @dave @erin")).toEqual({
      logins: ["alice", "bob", "carol", "dave", "erin"],
      userIds: ["ou_alice", "ou_bob", "ou_carol", "ou_dave", "ou_erin"],
    });
  });

  it("ignores the reserved words @all and @here", () => {
    expect(targets("@all please look at this")).toBeUndefined();
    expect(targets("@here roll call")).toBeUndefined();
  });

  it("ignores a team or repository reference", () => {
    expect(targets("thanks @platform-team/reviewers")).toBeUndefined();
    expect(targets("see @alice/notify-bus")).toBeUndefined();
  });

  it("ignores a login the channel does not map", () => {
    expect(targets("@stranger please look")).toBeUndefined();
    expect(targets("nothing addressed here")).toBeUndefined();
  });

  it("keeps only the mapped people out of a mixed comment", () => {
    expect(targets("@stranger @alice @platform-team/x @All")?.logins).toEqual(["alice"]);
  });

  it("refuses a comment whose author is not mapped", () => {
    // The conservative half of the policy: a stranger on a public repository
    // cannot make notify-bus @ a teammate, however they phrase it.
    expect(resolveMentionTargets("@alice please review", lookup, "stranger")).toBeUndefined();
    expect(
      resolveMentionTargets("@alice", normalizeMentionMap(undefined), "alice"),
    ).toBeUndefined();
  });

  it("treats an unreadable map as an empty one rather than throwing", () => {
    const junk = normalizeMentionMap({ alice: 5, "": "ou_x", bob: "  " } as unknown as Record<
      string,
      string
    >);
    expect(junk.size).toBe(0);
    expect(resolveMentionTargets("@alice", junk, "alice")).toBeUndefined();
  });
});

describe("commentBodyOf", () => {
  it("reads the comment body both comment events nest", () => {
    expect(commentBodyOf({ comment: { body: "ping @alice" } })).toBe("ping @alice");
  });

  it("is empty when the payload has no comment", () => {
    expect(commentBodyOf({})).toBe("");
    expect(commentBodyOf({ comment: null })).toBe("");
    expect(commentBodyOf({ comment: { body: 42 } })).toBe("");
  });
});

/** An event carrying whatever metadata a test wants to read back. */
function message(metadata: Record<string, unknown>): EventMessage {
  return {
    id: "evt-1",
    event: "issue_comment",
    repository: { full_name: "org/repo", html_url: "https://gh/o/r" },
    actor: { login: "carol", avatar_url: "" },
    payload: {},
    metadata,
  };
}

describe("readMentionTargets", () => {
  it("reads the targets a decision attached", () => {
    const attached = { logins: ["alice"], userIds: ["ou_alice"] };
    expect(readMentionTargets(message({ mentions: attached }))).toEqual(attached);
  });

  it("is empty when nothing was resolved", () => {
    expect(readMentionTargets(message({}))).toEqual({ logins: [], userIds: [] });
    expect(readMentionTargets(message({ mentions: { userIds: "ou_alice" } }))).toEqual({
      logins: [],
      userIds: [],
    });
  });
});
