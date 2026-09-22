/**
 * Inline template rendering (M1 stopgap).
 *
 * The middleware pipeline (Filter → Enricher → Template) lands in M2. Until
 * then, this module does a one-shot Handlebars render of the configured
 * template straight into `EventMessage.formatted`, so the adapter has a body
 * to send.
 *
 * When no template is configured for an event, `formatted.body` is left EMPTY
 * rather than filled with a generic summary. Two reasons (#16):
 *
 *   1. Every card builder already renders the event itself — header, actor,
 *      repo, stats — so a generic `event / Repo / User` body could only repeat
 *      what the card already shows.
 *   2. `buildFallbackCard` composes its body with `body || lines`, i.e. a
 *      non-empty body *replaces* the fallback's own content. A generic default
 *      therefore silently discarded the enriched fallback body — comment text,
 *      parent issue title, membership details — that #12/#13/#14 added.
 *
 * M2 will replace this with the Template middleware; this module then either
 * becomes the empty-body default or is removed.
 */
import Handlebars from "handlebars";
import type { EventMessage } from "../../types";

/** Render the given Handlebars source against the event, filling formatted. */
export function renderFormatted(
  message: EventMessage,
  templateSource: string | undefined,
): EventMessage {
  const source = templateSource?.trim() ?? "";
  const body =
    source.length > 0
      ? Handlebars.compile(source, { noEscape: true })(message)
      : "";
  return {
    ...message,
    formatted: {
      title: `${message.event} · ${message.repository.full_name}`,
      body,
    },
  };
}
