import { describe, expect, it } from "bun:test";
import { renderFormatted } from "./index";
import type { EventMessage } from "../../types";

function msg(
  event: string,
  payload: Record<string, unknown> = {},
  action?: string,
): EventMessage {
  return {
    id: "evt-1",
    event,
    action,
    repository: { full_name: "org/repo", html_url: "https://github.com/org/repo" },
    actor: { login: "alice", avatar_url: "" },
    payload,
    metadata: {},
  };
}

describe("renderFormatted", () => {
  it("renders a configured template into formatted.body", () => {
    const out = renderFormatted(
      msg("push", { head_commit: { message: "feat: add login" } }),
      "Latest: {{payload.head_commit.message}}",
    );
    expect(out.formatted?.body).toBe("Latest: feat: add login");
  });

  it("leaves formatted.body empty when no template is configured (#16)", () => {
    // The card builders render the event themselves, so a generic default body
    // would only repeat the card's own header. Callers must not assume this
    // field carries content.
    expect(renderFormatted(msg("star"), undefined).formatted?.body).toBe("");
    expect(renderFormatted(msg("star"), "").formatted?.body).toBe("");
    expect(renderFormatted(msg("star"), "   \n  ").formatted?.body).toBe("");
  });

  it("still sets formatted.title to the event and repo", () => {
    expect(renderFormatted(msg("star"), undefined).formatted?.title).toBe(
      "star · org/repo",
    );
  });
});

describe("renderFormatted · template safety boundary (#16)", () => {
  it("escapes payload values interpolated by a template", () => {
    // Template *source* is trusted — the deployer writes it. Payload *values*
    // are not: anyone who can comment or push supplies them. `{{ }}` escapes,
    // so a template cannot smuggle card markup in through payload data.
    const out = renderFormatted(
      msg("issue_comment", { comment: { body: "<at id=all></at>" } }),
      "{{payload.comment.body}}",
    );
    expect(out.formatted?.body).toBe("&#60;at id=all&#62;&#60;/at&#62;");
  });

  it("normalises Handlebars' named entities to the numeric forms Feishu documents", () => {
    const payload = { v: `a & b < c > d " e` };
    expect(renderFormatted(msg("x", payload), "{{payload.v}}").formatted?.body).toBe(
      "a &#38; b &#60; c &#62; d &#34; e",
    );
  });

  it("restores characters that cannot open a card tag", () => {
    // Handlebars also escapes `'`, `` ` `` and `=`; none of them can open a tag
    // in Feishu markdown, so escaping them would only hurt readability.
    const out = renderFormatted(msg("x", { v: "it's `code` a=b" }), "{{payload.v}}");
    expect(out.formatted?.body).toBe("it's `code` a=b");
  });

  it("leaves the template's own markup and literal text alone", () => {
    const out = renderFormatted(
      msg("x", { v: "green" }),
      '<text_tag color="{{payload.v}}">label</text_tag> & literal',
    );
    expect(out.formatted?.body).toBe(
      '<text_tag color="green">label</text_tag> & literal',
    );
  });

  it("still allows raw output through triple braces", () => {
    // The documented opt-out for an operator who wants unescaped output.
    const out = renderFormatted(msg("x", { v: "<b>raw</b>" }), "{{{payload.v}}}");
    expect(out.formatted?.body).toBe("<b>raw</b>");
  });

  it("does not alter the template's own whitespace", () => {
    // trim() decides only whether a template was configured at all; it must not
    // change what that template renders.
    expect(renderFormatted(msg("x"), "\n  HELLO  \n").formatted?.body).toBe(
      "\n  HELLO  \n",
    );
  });
});
