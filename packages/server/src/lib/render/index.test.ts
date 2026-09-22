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
    // The card builders render the event themselves. A generic default body
    // would repeat the card's own header, and because buildFallbackCard
    // composes its body with `body || lines`, a non-empty default silently
    // discarded the fallback card's enriched content.
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
