/**
 * Targeted @ mentions (#36).
 *
 * GitHub knows who a comment names; Feishu renders a real mention only from
 * markup. This module is the one place that turns the first into the second: a
 * route's `mention_only` policy and the card that is finally sent both read the
 * result of a single parse, carried on `EventMessage.metadata`, so the decision
 * and its card cannot disagree about who was addressed.
 *
 * The first version maps logins to Feishu `user_id`s by hand in the channel
 * config, on the strength of a spike in a real test group: a custom-bot schema
 * 2.0 card with `<at id=<user_id>></at>` came back `code: 0`, rendered as a real
 * mention, and reached the user as a client notification. Nothing here fetches
 * contacts, does OAuth, manages users, or falls back to `open_id`.
 */
import type { EventMessage } from "../../types";

/** A channel's GitHub login → Feishu user id map, as authored in YAML. */
export type MentionMap = Readonly<Record<string, string>>;

/** The same map, normalized: trimmed, lower-cased logins → trimmed ids. */
export type MentionLookup = ReadonlyMap<string, string>;

/** The people a card will @, in the order the comment named them. */
export interface MentionTargets {
  readonly logins: readonly string[];
  readonly userIds: readonly string[];
}

/**
 * How many people one card may @.
 *
 * Conservative on purpose: the point of the policy is a targeted ping, and a
 * comment naming a crowd should not become one.
 */
export const MAX_MENTIONS = 5;

/**
 * The `metadata` key a resolved decision travels under.
 *
 * Internal plumbing: `EventMessage`'s own shape is unchanged, and nothing
 * outside this package reads the key.
 */
export const MENTIONS_METADATA_KEY = "mentions";

/**
 * Names that address a whole chat rather than a person.
 *
 * Used for both sides of the map: a *login* of this name would never be read
 * out of a comment, and a Feishu *id* of this name (`<at id=all>`) would ping
 * everyone in the group. Neither may ever reach a card.
 */
const RESERVED = new Set(["all", "here"]);

/** Whether a login or Feishu id names a whole chat instead of one person. */
export function isReservedMention(name: string): boolean {
  return RESERVED.has(normalizeLogin(name));
}

/**
 * `@login` at a mention position.
 *
 * The preceding character matters, and each exclusion is a real false positive:
 * `foo@bar.com`, `user+tag@host` and `first.last@host` are addresses; a mention
 * in `https://example.com/@alice` is a path; `\@alice` was escaped; and `@@alice`
 * is not an address either.
 */
const MENTION = /(?:^|[^\w.+%\\/@-])@([a-z0-9][a-z0-9-]{0,38})/gi;

/** Characters a login can continue into: `@alice_smith` names somebody else. */
const LOGIN_CONTINUATION = /[\w-]/;

/** GitHub logins are case-insensitive; so is every lookup here. */
function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

/**
 * Drop code before looking for mentions.
 *
 * A mention inside code is code — reading it would ping somebody because a
 * comment quoted a command. Fenced blocks (three or more backticks, or `~~~`)
 * go first, then inline code, and a run of backticks counts (` ``x`` ` is how a
 * comment writes code that itself contains a backtick).
 */
function stripCode(text: string): string {
  return text
    .replace(/`{3,}[\s\S]*?`{3,}/g, " ")
    .replace(/`+[^`\n]*`+/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ");
}

/** The lookup form of a channel's map. A missing or unreadable map is empty. */
export function normalizeMentionMap(map: MentionMap | undefined): MentionLookup {
  const lookup = new Map<string, string>();
  for (const [login, userId] of Object.entries(map ?? {})) {
    const id = typeof userId === "string" ? userId.trim() : "";
    const key = normalizeLogin(login);
    if (key !== "" && id !== "") lookup.set(key, id);
  }
  return lookup;
}

/** The channel's user id for one login, or `undefined` when it maps none. */
export function mappedUserId(lookup: MentionLookup, login: string | undefined): string | undefined {
  return login === undefined ? undefined : lookup.get(normalizeLogin(login));
}

/** The comment text both comment events nest, or `""` when the payload has none. */
export function commentBodyOf(payload: Record<string, unknown>): string {
  const comment = payload.comment;
  if (comment === null || typeof comment !== "object") return "";
  const body = (comment as Record<string, unknown>).body;
  return typeof body === "string" ? body : "";
}

/**
 * The @ targets a `mention_only` route may send, or `undefined` when the policy
 * refuses the comment.
 *
 * Two things have to hold, and both err towards silence:
 *
 *   - the comment's plain text names somebody this channel maps, and
 *   - the comment comes from somebody this channel maps as well, so a stranger
 *     on a public repository cannot make notify-bus @ a teammate.
 *
 * A login has to be a whole token: `@alice_smith`, `example.com/@alice`,
 * `\@alice`, `@alice/notify-bus` and anything inside code name nobody. Matches
 * are case-insensitive, one @ per *person* — two logins mapped to the same
 * Feishu id are that person, and are mentioned once — and capped at
 * {@link MAX_MENTIONS}. Whether the event is one that may mention at all is the
 * caller's decision: an edit or a deletion is not (#36).
 */
export function resolveMentionTargets(
  body: string,
  lookup: MentionLookup,
  authorLogin: string,
): MentionTargets | undefined {
  if (!lookup.has(normalizeLogin(authorLogin))) return undefined;

  const logins: string[] = [];
  const userIds: string[] = [];
  const text = stripCode(body);
  for (const match of text.matchAll(MENTION)) {
    const login = normalizeLogin(match[1] ?? "");
    if (login === "" || RESERVED.has(login)) continue;
    const end = match.index + match[0].length;
    if (LOGIN_CONTINUATION.test(text[end] ?? "") || text[end] === "/") continue;
    const userId = lookup.get(login);
    if (userId === undefined || userIds.includes(userId)) continue;
    if (userIds.length === MAX_MENTIONS) break;
    logins.push(login);
    userIds.push(userId);
  }
  return userIds.length > 0 ? { logins, userIds } : undefined;
}

/** The targets an earlier decision attached to this event, if any. */
export function readMentionTargets(message: EventMessage): MentionTargets {
  const raw = message.metadata[MENTIONS_METADATA_KEY] as Partial<MentionTargets> | undefined;
  return {
    logins: Array.isArray(raw?.logins) ? raw.logins : [],
    userIds: Array.isArray(raw?.userIds) ? raw.userIds : [],
  };
}
