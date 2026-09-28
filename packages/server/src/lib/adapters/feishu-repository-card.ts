/**
 * `repository` — the repository itself changed: renamed, transferred, its
 * visibility flipped, archived or deleted.
 *
 * Split out of `feishu-cards.ts` with the `issue_comment` card (#21), whose
 * review asked for these two builders to stop growing that file. Shared
 * vocabulary comes from `feishu-card-kit.ts`.
 */
import type { EventMessage } from "../../types";
import {
  actionBadge,
  asObj,
  asStr,
  hr,
  markdown,
  md,
  navigationButtons,
  type CardColor,
  type CardElement,
  type FeishuCard,
} from "./feishu-card-kit";

/**
 * What a `repository` event changed, as far as the payload states it.
 *
 * Every field is optional because each comes from a nested `changes` path that
 * a partial payload may omit — the card then leaves the line out rather than
 * render `undefined` (#21).
 */
interface RepositoryChange {
  /** `renamed`: the name the repository had before. */
  previousName?: string;
  /** `transferred`: the login of the owner it came from. */
  previousOwner?: string;
  /**
   * The repository's current visibility, read from `repository.private` **only**.
   *
   * The repository object also carries a `visibility` string, and reading it
   * would be a bug: the action is what makes the claim ("this event made the
   * repository private"), and `private` is the field that agrees with it —
   * `visibility` is a coarser, separately-updated field that can still hold the
   * old value in the very payload announcing the change (#21).
   */
  isPrivate?: boolean;
}

function resolveRepositoryChange(
  payload: Record<string, unknown>,
): RepositoryChange {
  const changes = asObj(payload.changes);
  const fromName = asStr(asObj(asObj(changes.repository).name).from);
  // A repository owner is a `user` or an `organization`, and `changes.owner.from`
  // holds whichever one the repository came from — see `ownerOf`.
  const previousOwner = ownerOf(asObj(changes.owner).from);
  const isPrivate = asObj(payload.repository).private;
  return {
    previousName: fromName,
    previousOwner,
    isPrivate: typeof isPrivate === "boolean" ? isPrivate : undefined,
  };
}

/**
 * The login of the owner a `changes.owner.from` object describes.
 *
 * Both owner shapes name themselves with a `login`, so both are read: GitHub's
 * documented example for `transferred` uses the `user` shape, and an
 * organization-owned previous owner carries the same `login` under
 * `organization`. Reading only `user` would silently drop the org case.
 */
function ownerOf(from: unknown): string | undefined {
  const owner = asObj(from);
  return asStr(asObj(owner.user).login) ?? asStr(asObj(owner.organization).login);
}

/**
 * Header colour for a `repository` event.
 *
 * This event spends most of its life on `edited`, so that is the quiet baseline
 * and every other action has to be visibly different from it — which is why
 * `archived` is not another grey (#21). The grouping is by what the reader has
 * to do about it: react to an irreversible change, notice a state change, or
 * nothing at all.
 */
function repositoryHeaderColor(action: string): CardColor {
  switch (action) {
    // Irreversible: the repository is gone, or its code is public for good.
    case "deleted":
    case "publicized":
      return "red";
    // Frozen read-only, or visible to fewer people than before — a state worth
    // noticing, but nothing was lost.
    case "archived":
    case "privatized":
      return "yellow";
    // Newly created, or writable again.
    case "created":
    case "unarchived":
      return "green";
    // The repository's identity changed.
    case "renamed":
      return "purple";
    case "transferred":
      return "carmine";
    // `edited` — the ordinary case — and any action GitHub adds later.
    default:
      return "grey";
  }
}

/**
 * Every line the card prints about the change is conditional on the payload
 * actually carrying it. GitHub states a change in `changes`, and a partial
 * payload (or an action whose `changes` shape differs) must degrade to a card
 * with less detail, never to one that reads "formerly undefined" (#21).
 */
export function buildRepositoryCard(
  message: EventMessage,
  body: string,
): FeishuCard {
  const p = message.payload;
  const repo = message.repository.full_name;
  const action = message.action ?? asStr(p.action) ?? "updated";
  const change = resolveRepositoryChange(p);
  // A deleted repository's payload still carries its `html_url`, but the
  // repository that URL addresses is gone, so the page does not resolve. The
  // card therefore drops the target rather than offering a button that leads
  // nowhere — the same rule the push card applies to the Compare link on a
  // deleted branch (#15) and #26's dead-link guard states for every card.
  const repoUrl = action === "deleted" ? "" : message.repository.html_url;

  const content: CardElement[] = [];
  if (action === "renamed" && change.previousName) {
    content.push(markdown(`✏️ formerly \`${md(change.previousName)}\``));
  }
  if (action === "transferred" && change.previousOwner) {
    content.push(markdown(`➡️ from **${md(change.previousOwner)}**`));
  }
  if (
    (action === "privatized" || action === "publicized") &&
    change.isPrivate !== undefined
  ) {
    // The whole line exists so the reader can see which way the visibility
    // went — see `resolveRepositoryChange` for why `private` decides it.
    content.push(markdown(change.isPrivate ? "🔒 private" : "🌐 public"));
  }
  if (body) content.push(markdown(body));

  const elements: CardElement[] = [];
  if (content.length > 0) elements.push(...content, hr());
  // A repository event is not about a person, so the sender is the right name
  // here — the same rule the fallback card applies to non-person events.
  elements.push(markdown(`👤 **${md(message.actor.login)}**`));
  // The repository is this card's own object, yet every repository button in
  // this module renders `default` (star, fork, the fallback, and the one
  // `navigationButtons` adds), so this card's is `default` too rather than a
  // lone exception. Passing it in as a target keeps the dead-button guard in
  // one place; `navigationButtons` sees the url already present and adds no
  // second button.
  elements.push(
    ...navigationButtons(
      [{ label: "View Repo", url: repoUrl, type: "default" }],
      repoUrl,
    ),
  );

  return {
    header: {
      title: `📦 ${action}`,
      subtitle: repo,
      template: repositoryHeaderColor(action),
      badges: [actionBadge(action)],
    },
    elements,
  };
}
