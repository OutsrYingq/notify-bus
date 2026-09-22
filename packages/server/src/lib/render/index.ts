/**
 * Inline template rendering (M1 stopgap).
 *
 * The middleware pipeline (Filter → Enricher → Template) lands in M2. Until
 * then, this module does a one-shot Handlebars render of the configured
 * template straight into `EventMessage.formatted`.
 *
 * When no template is configured for an event, `formatted.body` is left EMPTY
 * rather than filled with a generic summary. Two reasons (#16):
 *
 *   1. Every card builder already renders the event itself — header, actor,
 *      repo, stats — so a generic `event / Repo / User` body could only repeat
 *      what the card already shows.
 *   2. The fallback card historically composed its body with `body || lines`, so
 *      a non-empty default replaced — and therefore discarded — the enriched
 *      fallback body that #12/#13/#14 added: comment text, parent issue title,
 *      membership details. The fallback composes now, but an empty default is
 *      still what stops an unconfigured deployment from repeating the header.
 *
 * M2 will replace this with the Template middleware; this module then either
 * becomes the empty-body default or is removed.
 */
import Handlebars from "handlebars";
import type { EventMessage } from "../../types";

/**
 * Normalise the HTML entities Handlebars emits into the forms Feishu documents
 * for card markdown.
 *
 * With escaping enabled Handlebars escapes `& < > " ' \` =`, emitting
 * `&amp; &lt; &gt; &quot; &#x27; &#x60; &#x3D;`. Two adjustments:
 *
 *   - the named forms become the *numeric* entities Feishu's escaping table
 *     lists (`&#60;` for `<`, `&#62;` for `>`);
 *   - `'`, `` ` `` and `=` are restored to the characters the payload actually
 *     contained, because none of them can open a card tag in Feishu markdown —
 *     escaping them would only make the output harder to read.
 *
 * `&amp;` is rewritten last so it cannot clobber an entity introduced by an
 * earlier step, and the rewrite cannot double-escape: Handlebars escapes `&`
 * first, so a literal `&lt;` in the payload arrives as `&amp;lt;`, which
 * contains no `&lt;` substring.
 */
function normaliseEntities(text: string): string {
  return text
    .replace(/&lt;/g, "&#60;")
    .replace(/&gt;/g, "&#62;")
    .replace(/&quot;/g, "&#34;")
    .replace(/&amp;/g, "&#38;")
    .replace(/&#x27;/g, "'")
    .replace(/&#x60;/g, "`")
    .replace(/&#x3D;/g, "=");
}

/**
 * Render the given Handlebars source against the event, filling formatted.
 *
 * ## Template safety boundary
 *
 * Template *source* is trusted — it is authored by whoever deploys notify-bus.
 * Interpolated *payload values* are not: they come from GitHub and from anyone
 * who can open an issue, push a commit or leave a comment.
 *
 * `noEscape: false` (Handlebars' default) is load-bearing for that split: it
 * escapes `{{payload.field}}`, so a template cannot inject card markup through
 * payload data, while the template's own literal markdown and tags are left
 * alone. An operator who genuinely wants raw output opts in explicitly with
 * triple braces, `{{{payload.field}}}` (see #16).
 */
export function renderFormatted(
  message: EventMessage,
  templateSource: string | undefined,
): EventMessage {
  // `source` keeps its original whitespace: trim is only used to decide whether
  // a template was configured at all, never to alter what it renders.
  const source = templateSource ?? "";
  const body =
    source.trim().length > 0
      ? normaliseEntities(
          Handlebars.compile(source, { noEscape: false })(message),
        )
      : "";
  return {
    ...message,
    formatted: {
      title: `${message.event} · ${message.repository.full_name}`,
      body,
    },
  };
}
