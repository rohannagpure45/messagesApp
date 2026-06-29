/**
 * Sawa discovery bot on Photon Spectrum.
 *
 * One handler against `app.messages`, delivered across every configured provider (iMessage in
 * production, terminal for dev). The default face is **cross-venue SEARCH**: a natural-language
 * query like "sawa FIFA World Cup" returns matched markets from Sawa (virtual coins) + Kalshi +
 * Polymarket (real money, via pmxt), Skyscanner-style — one compact line per market with a link.
 *
 * Reads are GET-only by construction (Option C — the public Sawa app API, no DB credentials).
 * Betting/creation are out of scope for this phase; pmxt is read-only enrichment, never a trade host.
 */
import "./env"; // MUST be first: loads ./.env into process.env before anything reads it.

import net from "node:net";
import path from "node:path";
import { Spectrum, text, markdown, richlink, poll } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import type { Space, Message } from "spectrum-ts";

import {
  getConfig,
  getPmxtConfig,
  getIntentConfig,
  ConfigError,
  type Config,
  type PmxtConfig,
  type IntentConfig,
} from "./sawa/config";
import { listMarkets, getMarket, enableFeedCachePersistence, fileFeedCachePersistence } from "./sawa/read";
import { formatList, formatMarket } from "./sawa/format";
import { stubCreate } from "./sawa/createStub";
import { RecentBuffer, suggestPayload } from "./sawa/suggest";
import { parseIntent, stripAddress, refineClarify } from "./sawa/intent";
import { runSearch, flattenRanked } from "./search";
import { enableCachePersistence, fileCachePersistence } from "./pmxt/discover";
import type { VenueResult } from "./venue";
import { toPlainText } from "./sawa/cards";
import { ConversationStore, toContext, nextTurn, clarifyState, resolveClarifyTurn, pickedAnswer } from "./sawa/conversation";
import { decideClarify, resolveAnswer, renderClarifyText, type ClarifyQuestion } from "./sawa/clarify";
import {
  SpaceSettings,
  fileSettingsPersistence,
  peelSettings,
  isSettingsQuery,
  confirmChanges,
  describeSettings,
} from "./sawa/settings";
import {
  shouldHandle,
  SeenSet,
  normalizeHandle,
  actionableWhenRelaxed,
  sessionKey,
  threadOwner,
  canRelaxSender,
} from "./routing";

// Single-instance lock (a localhost mutex, NOT a network server). Two bot processes on one Photon
// project duel over the iMessage subscription — Photon delivers each text to only one of them, so
// replies silently vanish. A second instance hits EADDRINUSE and exits loudly. SAWA_NO_LOCK=1 bypasses.
if (process.env.SAWA_NO_LOCK !== "1") {
  const LOCK_PORT = Number(process.env.SAWA_LOCK_PORT) || 47615;
  await new Promise<void>((resolve) => {
    const lock = net.createServer();
    lock.unref();
    lock.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `[sawa] ✋ Another sawa instance is already running (lock :${LOCK_PORT}). Refusing to start a second —\n` +
            `       duplicate instances fight over the Photon line, so iMessage replies vanish.\n` +
            `       Stop the other first:  pkill -f 'src/index.ts'   (or set SAWA_NO_LOCK=1 to override)`,
        );
        process.exit(1);
      }
      resolve(); // any other lock error → don't block startup
    });
    lock.listen(LOCK_PORT, "127.0.0.1", () => resolve());
  });
}

// Config is required for the read/search commands; load once and fail soft so the TUI still boots.
let config: Config | null = null;
try {
  config = getConfig();
} catch (err) {
  if (err instanceof ConfigError) console.warn(`[sawa] read/search disabled: ${err.message}`);
  else throw err;
}
const pmxtConfig: PmxtConfig | null = getPmxtConfig();
const intentConfig: IntentConfig | null = getIntentConfig();
const botName = config?.botName ?? "sawa";

console.warn(
  `[sawa] search enrichment — pmxt: ${pmxtConfig ? "on" : "off (Sawa-only)"}; ` +
    `intent LLM: ${intentConfig ? "on" : "off (regex gate)"}.`,
);

const HELP = [
  `Sawa bot — find prediction markets across Sawa, Kalshi & Polymarket.`,
  `Just ask: "${botName} FIFA World Cup"  or  "${botName} where can I bet on the election"`,
  `Settings: "${botName} quips off"  ·  "${botName} sawa only"  ·  "${botName} settings"`,
  ``,
  `Slash commands:`,
  `/search <topic>   cross-venue search (Sawa + Kalshi + Polymarket)`,
  `/markets          list open Sawa markets`,
  `/show <id>        full detail for one Sawa market`,
  `/help             show this`,
].join("\n");

const TERMINAL_COMMANDS = [
  { name: "/search", description: "Cross-venue search (Sawa + Kalshi + Polymarket)" },
  { name: "/markets", description: "List open Sawa markets" },
  { name: "/show", description: "Show one Sawa market by id" },
  { name: "/create", description: "Preview a market (stub — nothing created)" },
  { name: "/suggest", description: "Suggest markets from recent chat (demo)" },
  { name: "/help", description: "Show commands" },
];

const hasPhoton = Boolean(process.env.PROJECT_ID && process.env.PROJECT_SECRET);
// LOCAL mode (SAWA_IMESSAGE_LOCAL=1): send/receive through THIS Mac's Messages app instead of the Photon
// cloud line — no PROJECT_ID/SECRET; the bot acts as the Mac's signed-in Apple ID. This is the free path to
// GROUP chat (a shared-pool cloud line can't do groups). Requires macOS + Full Disk Access; markdown is
// stripped (we send plain text + bare URLs) and it can't create groups, but it replies to groups it's in.
// SAFETY: it sees every iMessage this Apple ID receives, so local mode requires an explicit "sawa …" hail
// EVERYWHERE (DMs too) and ignores our own sends — so it won't auto-reply to your other chats. Wins over cloud.
const localImessage = process.env.SAWA_IMESSAGE_LOCAL === "1" || process.env.SAWA_IMESSAGE_LOCAL === "true";
const cloudImessage = hasPhoton && !localImessage;
const imessageOn = localImessage || cloudImessage;

console.warn(
  localImessage
    ? "[sawa] iMessage: LOCAL mode — via this Mac's Messages app (acts as the Mac's Apple ID). Free path to " +
        "groups (needs macOS + Full Disk Access). Responds ONLY to 'sawa …' hails everywhere; markdown → plain text."
    : cloudImessage
      ? "[sawa] iMessage: ENABLED — connecting to the Photon line. Text it, then watch for '⟵ inbound' below."
      : "[sawa] iMessage: DISABLED — set SAWA_IMESSAGE_LOCAL=1 (local, free) or PROJECT_ID/PROJECT_SECRET (cloud) → terminal-only.",
);
if (cloudImessage) {
  // Group-chat caveat (line model, not code): 1:1 DMs work on any line, but a GROUP needs one number
  // every member sees — i.e. a dedicated (Business) line. On a shared pool each end user is routed
  // through a *different* pool number, so group delivery is unreliable. See docs/IMESSAGE_TESTING.md.
  console.warn(
    "[sawa] note: 1:1 DMs work on any line; reliable GROUP chat needs a dedicated (Business) line " +
      "(a shared pool routes each user via a different number) — or run SAWA_IMESSAGE_LOCAL=1 (free).",
  );
}

// Headless mode (SAWA_HEADLESS=1) drops the terminal TUI so iMessage runs alone and console logs
// flow straight to stdout/stderr — used to capture clean connection logs when debugging the line.
const headless = (process.env.SAWA_HEADLESS === "1" || process.env.SAWA_HEADLESS === "true") && imessageOn;
if (headless) {
  console.warn("[sawa] headless mode — terminal TUI off, iMessage only (clean logs for debugging).");
}

const providers = [
  ...(localImessage ? [imessage.config({ local: true })] : cloudImessage ? [imessage.config()] : []),
  ...(headless ? [] : [terminal.config({ commands: TERMINAL_COMMANDS })]),
];

const app = cloudImessage
  ? await Spectrum({
      projectId: process.env.PROJECT_ID!,
      projectSecret: process.env.PROJECT_SECRET!,
      providers,
    })
  : await Spectrum({ providers });

const recent = new RecentBuffer(20);
const seen = new SeenSet(1000);
// Per-conversation memory for the folk-style flow: the last search's ranked candidates + a cursor, so
// follow-ups ("not that" / "send the kalshi link") resolve without re-searching. Keyed PER (space,
// sender) via sessionKey() — each member keeps their own thread; one member's hail doesn't relax others.
const convo = new ConversationStore();
// SAWA_FOLK_TONE=1 appends a brief editorial flourish to the conversational reply (off by default;
// factual otherwise). See cards.folkQuip — deliberately mild + category-blind for brand safety.
const folkTone = process.env.SAWA_FOLK_TONE === "1" || process.env.SAWA_FOLK_TONE === "true";
// Agent settings the user can toggle from chat ("quips off", "sawa only", "settings"). Sticky per
// space and DURABLE: written through to a bot-local JSON file (gitignored .sawa/, override via
// SAWA_SETTINGS_FILE) so a toggle persists for days/weeks across restarts until changed again. The
// env defaults (quips ← SAWA_FOLK_TONE, external ← pmxt configured) only seed a never-set space. This
// is bot-local UX state, NOT a Sawa DB write. See src/sawa/settings.ts + docs/AGENT_SETTINGS.md.
const settingsFile = process.env.SAWA_SETTINGS_FILE || path.join(process.cwd(), ".sawa", "settings.json");
const settings = new SpaceSettings(
  { quips: folkTone, external: pmxtConfig !== null },
  { persist: fileSettingsPersistence(settingsFile) },
);
console.warn(`[sawa] agent settings: persisting per-space toggles to ${settingsFile} (survives restart).`);

// pmxt (venue,query) cache — DURABLE across restart (follow-up C): rehydrate from a bot-local JSON
// file (gitignored .sawa/, override via SAWA_PMXT_CACHE_FILE) so a cold redeploy doesn't start with an
// empty cache and re-burst pmxt (the 429 source). Read-only enrichment data, NOT a Sawa write. Only
// when pmxt is configured (no key → the cache is never used).
if (pmxtConfig) {
  const pmxtCacheFile = process.env.SAWA_PMXT_CACHE_FILE || path.join(process.cwd(), ".sawa", "pmxt-cache.json");
  enableCachePersistence(fileCachePersistence(pmxtCacheFile));
  console.warn(`[sawa] pmxt cache: persisting to ${pmxtCacheFile} (survives restart).`);
}

// Sawa public-feed cache — DURABLE across restart for a WARM cold start: rehydrate the feed page from
// a bot-local JSON file (gitignored .sawa/, override via SAWA_FEED_CACHE_FILE) so the first query after
// a redeploy is served from disk in ~ms (stale-while-revalidate refreshes it) instead of paying the
// ~1s origin GET. Read-only enrichment data, NOT a Sawa write. See src/sawa/read.ts.
const feedCacheFile = process.env.SAWA_FEED_CACHE_FILE || path.join(process.cwd(), ".sawa", "feed-cache.json");
enableFeedCachePersistence(fileFeedCachePersistence(feedCacheFile));
console.warn(`[sawa] feed cache: persisting to ${feedCacheFile} (warm cold start).`);

function needsConfig(): string {
  return "Sawa isn't configured yet (set SAWA_API_BASE_URL).";
}

/** Group vs DM detection. Only iMessage has groups; gate on platform before narrowing (it throws otherwise). */
function isGroupSpace(space: Space, message: Message): boolean {
  if (message.platform === "iMessage") {
    try {
      return imessage(space).type === "group";
    } catch {
      return false;
    }
  }
  return false;
}

/** True if WE sent this message. Local mode reads the Mac's chat.db, which includes our own sends — without
 *  this skip the bot would reply to its own (and the same Apple ID's) messages and loop. No-op off iMessage. */
function isFromSelf(message: Message): boolean {
  if (message.platform !== "iMessage") return false;
  try {
    return imessage(message).direction === "outbound";
  } catch {
    return false;
  }
}

/**
 * Send a conversational reply body. Cloud iMessage renders markdown() as native styled text; LOCAL
 * mode + terminal strip formatting, so send plain text with bare (still tappable) URLs there. Sends
 * are BEST-EFFORT: a flaky/lost-ack send (a DEADLINE_EXCEEDED frequently still DELIVERS) must not
 * bubble up into the handler's "unreachable" apology.
 */
async function sendBody(space: Space, body: string): Promise<void> {
  await guard("reply send", () => space.send(localImessage ? text(toPlainText(body)) : markdown(body)));
}

/**
 * Hand out a market link as its OWN message so iMessage unfurls it into a rich Open Graph card — the
 * market's title + cover image — instead of the flat tappable link you get when a URL is buried in a
 * sentence. Cloud/dedicated iMessage: `richlink(url)` (the provider sends the bare URL with link
 * preview enabled). LOCAL iMessage supports only text + attachments, so send the bare URL ALONE — the
 * Mac's Messages app unfurls a lone URL the same way. Terminal: a plain URL line. Best-effort: a flaky
 * send must never bubble into the handler's "unreachable" apology, and a malformed URL that makes
 * `richlink` throw at build time is swallowed here rather than crashing the loop.
 */
async function sendLink(space: Space, target: VenueResult, platform: string): Promise<void> {
  const url = target.url;
  if (!url) return;
  const richCapable = platform === "iMessage" && !localImessage; // cloud/dedicated line unfurls richlink
  await guard("link send", () => space.send(richCapable ? richlink(url) : text(url)));
}

/**
 * Can THIS platform render a native iMessage Poll? Cloud iMessage + the terminal TUI can; LOCAL
 * iMessage (the Mac's Messages app) is text + attachments only, so it falls back to a numbered list.
 */
function pollCapable(platform: string): boolean {
  return !(platform === "iMessage" && localImessage);
}

/**
 * Ask a clarifying question: a native Poll where supported (the user taps a choice → a `poll_option`
 * event we resolve in the loop), else a numbered text list (the user replies "2" / the name → resolved
 * on the text path). Both correlate back to the `pending` question stored in conversation state.
 */
async function sendClarify(space: Space, question: ClarifyQuestion, platform: string): Promise<void> {
  if (pollCapable(platform)) {
    await guard("clarify poll", () => space.send(poll(question.question, ...question.options.map((o) => o.label))));
  } else {
    await sendBody(space, renderClarifyText(question));
  }
}

/**
 * Run a fresh cross-venue search. When several DISTINCT markets match one topic (e.g. "bitcoin"), ASK
 * which one (a poll / numbered list) instead of guessing; otherwise reply with the single best market.
 * Either way the thread state is stored so follow-ups ("not that" / "send the link") resolve.
 *
 * `isGroup` decides thread ownership (routing.ts `threadOwner` / `sessionKey`): a DM binds to the space
 * so a pending clarify survives local-mode handle flapping; a group binds per sender.
 */
async function runConversationalSearch(
  space: Space,
  spaceId: string,
  query: string,
  platform: string,
  senderId: string,
  isGroup: boolean,
): Promise<void> {
  if (!config) return void (await guard("config notice", () => space.send(needsConfig())));
  const sKey = sessionKey(spaceId, senderId, isGroup);
  // Resolve agent settings for this space: "sawa only" drops external enrichment; "quips" sets the tone.
  const pmxt = settings.get(spaceId, "external") ? pmxtConfig : null;
  const folkTone = settings.get(spaceId, "quips");
  const results = await runSearch(query, { config, pmxt });
  const candidates = results.empty ? [] : flattenRanked(results);

  // Ambiguous topic → ask which market. Deterministic decision; the LLM may drop noise / narrow / veto.
  if (candidates.length > 0) {
    let question = decideClarify(candidates, query);
    if (question && intentConfig) question = await refineClarify(query, question, intentConfig);
    if (question && question.options.length >= 2) {
      // Bind the pending question to the thread OWNER (DM → the space; group → the sender) so only the
      // right party answers it with unhailed text — and a DM answer survives the local handle flapping.
      convo.set(sKey, clarifyState(query, candidates, results, question, threadOwner(spaceId, senderId, isGroup)));
      await sendClarify(space, question, platform);
      return;
    }
    if (question && question.options.length === 1) {
      // The LLM filtered down to ONE relevant market → show THAT one (not candidates[0], which may be
      // the off-topic noise the filter just rejected).
      const outcome = pickedAnswer(query, candidates, results, question.options[0]!.result, { folkTone });
      convo.set(sKey, outcome.newState);
      await sendBody(space, outcome.body);
      return;
    }
  }

  // Single best answer (the folk-style one-liner) or the graceful empty-state — via the pure reducer.
  const outcome = nextTurn(null, { kind: "search", query, via: "regex" }, results, { folkTone });
  convo.set(sKey, outcome.newState);
  await sendBody(space, outcome.body);
}

/** Slash-command fallback (power users + the terminal TUI). */
async function handleSlash(
  space: Space,
  cmd: string,
  arg: string,
  platform: string,
  senderId: string,
  isGroup: boolean,
): Promise<void> {
  switch (cmd) {
    case "/search": {
      if (!arg) return void (await space.send("Usage: /search <topic>"));
      await runConversationalSearch(space, space.id, arg, platform, senderId, isGroup);
      return;
    }
    case "/markets": {
      if (!config) return void (await space.send(needsConfig()));
      await space.send(formatList(await listMarkets(config, { limit: 10 })));
      return;
    }
    case "/show": {
      if (!config) return void (await space.send(needsConfig()));
      if (!arg) return void (await space.send("Usage: /show <market-id>"));
      const market = await getMarket(config, arg);
      if (!market) return void (await space.send(`No public market with id "${arg}".`));
      await space.send(text(formatMarket(market)));
      if (market.url) await space.send(richlink(market.url));
      return;
    }
    case "/create": {
      await space.send(stubCreate(arg || "(no question provided)").message);
      return;
    }
    case "/suggest": {
      if (!config) return void (await space.send(needsConfig()));
      const markets = await listMarkets(config, { limit: 20 });
      const payload = suggestPayload(markets, recent.recent("terminal"));
      await space.send(
        `(demo) ${payload.guidance}\n` +
          `Context: ${payload.messages.length} recent message(s); ${markets.length} open markets in snapshot.`,
      );
      return;
    }
    default:
      await space.send(HELP);
  }
}

/**
 * Natural-language path. `relaxed` is true when the message was NOT hailed but there's an active thread
 * in this space (so follow-ups + clarify answers work without re-typing "sawa"); in that mode we only
 * continue the thread or honor an explicit search, staying silent on anything else.
 *
 * Order: resolve a pending clarify answer ("2" / "the kalshi one") → settings (hailed only) → classify
 * intent WITH thread context → route. A `search` runs a fresh lookup; `next`/`link` page the stored
 * candidates via the pure reducer; `other` nudges (only when hailed).
 */
async function handleNatural(
  space: Space,
  body: string,
  platform: string,
  relaxed: boolean,
  senderId: string,
  isGroup: boolean,
): Promise<void> {
  const spaceId = space.id;
  const owner = threadOwner(spaceId, senderId, isGroup);
  const sKey = sessionKey(spaceId, senderId, isGroup);
  let state = convo.get(sKey) ?? null;
  const addressed = stripAddress(body, botName);

  // A pending clarify ("which market?") answer on the TEXT path (poll taps resolve in the loop). Bound
  // to the thread OWNER: in a group a bystander's "2" is NOT their answer to give; in a DM the owner is
  // the space, so the answer resolves even when this inbound's handle didn't resolve (local flapping).
  let repliedToPending = false;
  if (state?.pending && state.pendingBy === owner) {
    const opt = resolveAnswer(state.pending, addressed);
    if (opt) {
      const outcome = resolveClarifyTurn(state, opt, { folkTone: settings.get(spaceId, "quips") });
      convo.set(sKey, outcome.newState);
      await sendBody(space, outcome.body);
      return;
    }
    // The asker replied to OUR question but it wasn't a listed option ("no, I meant <refined topic>").
    // It's still a direct reply addressed to us, so drop the pending, mark it, and treat the refinement
    // as a fresh intent that bypasses the relaxed-actionability gate below (else a non-regex refinement
    // would be silently dropped — the live "No I meant s&p price range today at 4pm" bug).
    repliedToPending = true;
    state = { ...state, pending: undefined, pendingBy: undefined };
    convo.set(sKey, state);
  }

  // Agent settings ("quips off", "sawa only", "settings") — resolved BEFORE search so a toggle phrase
  // is applied, never searched. Only when explicitly hailed: a relaxed/overheard message must not toggle
  // config. `peelSettings` also strips a LEADING toggle off a compound ("turn on quips, look for X").
  if (!relaxed) {
    if (isSettingsQuery(addressed)) {
      await sendBody(space, describeSettings(settings.resolved(spaceId)));
      return;
    }
    const { changes, rest } = peelSettings(addressed);
    if (changes.length) {
      for (const c of changes) settings.set(spaceId, c.key, c.on);
      await sendBody(space, confirmChanges(changes));
      if (!rest) return; // pure toggle — nothing left to do
      body = rest; // continue with the remainder of the compound (address already stripped)
    }
  }

  const intent = await parseIntent(body, botName, intentConfig, toContext(state));

  // Relaxed (overheard, active thread): act on a thread follow-up, a DM search, or a group's EXPLICIT
  // search request (`actionableWhenRelaxed`) — UNLESS this is a direct reply to a clarify we asked
  // (`repliedToPending`), which is always honored since the user is answering our own question.
  if (relaxed && !repliedToPending && !actionableWhenRelaxed(intent, isGroup)) return;

  if (intent.kind === "search" && intent.query) {
    await runConversationalSearch(space, spaceId, intent.query, platform, senderId, isGroup);
    return;
  }
  if (intent.kind === "answer" && intent.reply) {
    // The LLM answered a question about the shown market from facts — no search, no state change.
    // Re-persist (unchanged) so the session TTL refreshes while the user is in a Q&A about it.
    if (state) convo.set(sKey, state);
    await sendBody(space, intent.reply);
    return;
  }
  if (intent.kind === "next" || intent.kind === "link") {
    const outcome = nextTurn(state, intent, null, { folkTone: settings.get(spaceId, "quips") });
    convo.set(sKey, outcome.newState);
    await sendBody(space, outcome.body);
    // A link turn carries the target market: send the URL as its own message so it unfurls into the
    // market's rich preview (image + title). `next` turns set no `link`, so this is link-only.
    if (outcome.link) await sendLink(space, outcome.link, platform);
    return;
  }
  // "other" (greeting / create / account / help) or a search with no extractable subject — nudge (the
  // relaxed case already returned above, so this only fires for an explicitly-addressed message).
  await space.send(
    `I find prediction markets across Sawa, Kalshi & Polymarket. ` +
      `Try "${botName} FIFA World Cup" or /help.`,
  );
}

/** Normalize a poll/question title for correlation (no poll id is delivered inbound — match by title). */
function normTitle(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * A native poll vote (`poll_option`) — the answer to a clarifying "which market?" poll. It needs NO
 * "sawa" hail (a deliberate tap on OUR poll bubble), and resolves against the VOTER's OWN session: the
 * pending question lives in the asker's per-sender session, so a tap only resolves the tapper's own
 * question (consistent with the text path). Correlated by TITLE (no poll id is delivered inbound — see
 * SPECTRUM_INTEGRATION §4) and idempotent on the vote id. Polls never reach LOCAL mode anyway.
 *
 * Known edge (title-only correlation): if the SAME query is re-asked before this vote lands, both polls
 * share a title but the new `pending` has different options — a stale tap then fails `resolveAnswer` and
 * is silently dropped (the user just taps the current poll). Message ordering is Spectrum-guaranteed, so
 * a vote arriving after the text path already cleared `pending` simply finds none and returns.
 */
async function handlePollVote(space: Space, message: Message, isGroup: boolean): Promise<void> {
  if (message.content.type !== "poll_option") return;
  if (!message.content.selected) return; // act on a selection, not a deselect
  if (isFromSelf(message)) return;
  const spaceId = space.id;
  const senderId = normalizeHandle(message.sender?.id || "unknown");
  const owner = threadOwner(spaceId, senderId, isGroup);
  const sKey = sessionKey(spaceId, senderId, isGroup);
  const state = convo.get(sKey);
  if (!state?.pending) return;
  if (state.pendingBy !== owner) return; // only the asker resolves their own poll (symmetric w/ text)
  if (normTitle(message.content.poll.title) !== normTitle(state.pending.question)) return; // not our poll
  if (seen.seen(message.id)) return; // at-least-once delivery → never resolve the same vote twice
  const opt = resolveAnswer(state.pending, message.content.option.title);
  if (!opt) return;
  const outcome = resolveClarifyTurn(state, opt, { folkTone: settings.get(spaceId, "quips") });
  convo.set(sKey, outcome.newState);
  await sendBody(space, outcome.body);
}

// Startup outbound initiation (SAWA_HELLO_TO="+15551234567", or a comma-separated list of handles).
// The bot messages the handle(s) FIRST. Rationale: on a Photon *shared pool*, the inbound→SDK route for a
// given end user is established when the project initiates the conversation to that registered user — a user
// who only ever cold-texts a pool line it was never addressed from may not be routed back to the stream
// (fits "Delivered, no reply"). It also converts an opaque "no inbound" into a concrete OUTBOUND result in
// our own logs: a thrown "Target not allowed for this project" pinpoints a handle/Users-allowlist mismatch
// (verify the real sending handle at https://debug.photon.codes).
async function sendHello(handles: string[]): Promise<void> {
  if (!cloudImessage) {
    console.warn("[sawa] SAWA_HELLO_TO is cloud-only (local mode can't create spaces / no Photon line) — skipping.");
    return;
  }
  const im = imessage(app);
  for (const handle of handles) {
    try {
      const user = await im.user(handle);
      const dm = await im.space.create(user);
      await dm.send(
        `Sawa here. Reply with "${botName} FIFA World Cup" (or "${botName} <any topic>") and I'll find ` +
          `markets across Sawa, Kalshi & Polymarket.`,
      );
      console.warn(`[sawa] ✅ hello → ${handle}: sent. Reply IN THIS THREAD now; watch for '⟵ inbound'.`);
    } catch (err) {
      console.error(
        `[sawa] ❌ hello → ${handle}: FAILED — this IS the diagnostic. A "Target not allowed" error ⇒ this ` +
          `handle isn't in your project's Users, or isn't the handle Apple sends you from (check ` +
          `https://debug.photon.codes). Raw error:`,
        err,
      );
    }
  }
}

const helloTo = (process.env.SAWA_HELLO_TO ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (helloTo.length) await sendHello(helloTo);

console.warn(
  imessageOn
    ? "[sawa] listening — text the bot NOW; expect '⟵ inbound [iMessage/…]' within a few seconds."
    : "[sawa] listening on terminal only.",
);

/**
 * Run provider-talking work, swallowing + logging any error so a transient outbound failure (e.g. a
 * Photon SetTyping / SendText `ECONNRESET` or `DEADLINE_EXCEEDED`) can never crash the long-running
 * message loop. A single failed reply took the whole bot down once (24-Jun) — this prevents a repeat.
 */
async function guard(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[sawa] ${label} failed (continuing): ${(err as Error)?.message ?? String(err)}`);
  }
}

for await (const [space, message] of app.messages) {
  // Logged for EVERY event before any filtering — the definitive "did Photon deliver anything" probe.
  console.warn(
    `[sawa] ⟵ event [${message.platform}] type=${message.content.type} from=${normalizeHandle(message.sender?.id ?? "unknown")}`,
  );
  const isGroup = isGroupSpace(space, message);
  // A native poll vote — the answer to a clarifying "which market?" poll. Handled before the text gate
  // (it carries no text/hail) and only acts on a pending clarify in this space. Cloud/terminal only.
  if (message.content.type === "poll_option") {
    await guard("poll vote", () => handlePollVote(space, message, isGroup));
    continue;
  }
  if (message.content.type !== "text") continue; // v1: text + poll_option (reactions land later)
  if (isFromSelf(message)) continue; // never act on our own sends (critical in local mode on a shared Apple ID)

  const body = message.content.text.trim();
  if (!body) continue;
  // `||` (not `??`) so an EMPTY handle — local-mode groups don't resolve every member's chat.db handle —
  // collapses to "unknown" and keys consistently (see sessionKey), rather than forking "" vs undefined.
  const senderId = normalizeHandle(message.sender?.id || "unknown");
  const isSlash = body.startsWith("/");

  // Operational visibility: prove inbound delivery per platform (esp. for debugging the iMessage line).
  console.warn(
    `[sawa] ⟵ inbound [${message.platform}/${isGroup ? "group" : "dm"}] from=${senderId} "${body.slice(0, 40)}"`,
  );

  // In local mode the bot reads the Mac's whole inbox, so require an explicit "sawa …" hail everywhere
  // (treat like a group) — otherwise it would auto-reply to every DM this Apple ID receives.
  const hailed = shouldHandle({ isGroup: isGroup || localImessage, isSlash, body, botName });
  // Relaxed follow-up: a non-hailed message is still handled WHEN the thread owner has an active session
  // in this space (within TTL) — so a poll/clarify answer ("2"), "send the kalshi link", a question about
  // the shown market, or "find a market on X" work without re-hailing. handleNatural still gates it to
  // follow-ups + explicit searches, staying silent on overheard chatter.
  //   - DM: ALWAYS relaxable (1:1 — the counterparty is unambiguous even when the handle didn't resolve;
  //     this is the fix for the "'2' ignored" bug, where the answer's handle flapped to "unknown").
  //   - GROUP: only KNOWN handles relax (an unknown member shares the per-space "unknown" bucket, so an
  //     unhailed bystander could otherwise ride another member's session) — they must hail each message.
  const relaxed =
    !hailed && canRelaxSender(senderId, isGroup) && convo.get(sessionKey(space.id, senderId, isGroup)) !== undefined;
  if (!hailed && !relaxed) {
    // Bystander chatter (not addressed, no active thread) — feed the buffer for future suggestions, no reply.
    console.warn(
      `[sawa] ⊘ ignored [${message.platform}/${isGroup ? "group" : "dm"}] from=${senderId} — not addressed (lead with "${botName} …" or @${botName}).`,
    );
    recent.push(senderId, body);
    continue;
  }

  // Idempotency: at-least-once delivery → never act twice on the same message id.
  if (seen.seen(message.id)) continue;

  // Reply directly — deliberately NOT via `space.responding()`: its SetTyping call throws on Photon's
  // flaky outbound and was aborting the whole reply before it ran (a typing indicator must never gate the
  // answer). A transient provider error is logged and skipped, never crashing the loop; both the reply and
  // the error-fallback send are guarded, and the conversational reply's sends are best-effort.
  await guard("message handling", async () => {
    try {
      if (isSlash) {
        const parts = body.split(/\s+/);
        const cmd = (parts[0] ?? "").toLowerCase();
        const arg = parts.slice(1).join(" ").trim();
        await handleSlash(space, cmd, arg, message.platform, senderId, isGroup);
      } else {
        await handleNatural(space, body, message.platform, relaxed, senderId, isGroup);
      }
    } catch (err) {
      console.error(`[sawa] handler failed:`, err);
      await guard("fallback send", () =>
        space.send("Sorry — Sawa is unreachable right now. Try again shortly."),
      );
    }
  });
}
