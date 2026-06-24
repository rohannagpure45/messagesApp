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
import { Spectrum, text, markdown, richlink } from "spectrum-ts";
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
import { listMarkets, getMarket } from "./sawa/read";
import { formatList, formatMarket } from "./sawa/format";
import { stubCreate } from "./sawa/createStub";
import { RecentBuffer, suggestPayload } from "./sawa/suggest";
import { parseIntent } from "./sawa/intent";
import { runSearch } from "./search";
import { renderSearch } from "./sawa/cards";
import { shouldHandle, SeenSet } from "./routing";

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

const DISCLAIMER = "Virtual Sawa coins — entertainment only, no cash value.";

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
  ``,
  `Slash commands:`,
  `/search <topic>   cross-venue search (Sawa + Kalshi + Polymarket)`,
  `/markets          list open Sawa markets`,
  `/show <id>        full detail for one Sawa market`,
  `/help             show this`,
  DISCLAIMER,
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
console.warn(
  hasPhoton
    ? "[sawa] iMessage: ENABLED — connecting to the Photon line. Text it, then watch for '⟵ inbound' below."
    : "[sawa] iMessage: DISABLED — PROJECT_ID and/or PROJECT_SECRET missing from .env → terminal-only. " +
        "(These are the Photon keys, separate from PMXT/SAWA — paste both from the dashboard, then restart.)",
);

// Headless mode (SAWA_HEADLESS=1) drops the terminal TUI so iMessage runs alone and console logs
// flow straight to stdout/stderr — used to capture clean connection logs when debugging the line.
const headless = (process.env.SAWA_HEADLESS === "1" || process.env.SAWA_HEADLESS === "true") && hasPhoton;
if (headless) {
  console.warn("[sawa] headless mode — terminal TUI off, iMessage only (clean logs for debugging).");
}

const providers = [
  ...(hasPhoton ? [imessage.config()] : []),
  ...(headless ? [] : [terminal.config({ commands: TERMINAL_COMMANDS })]),
];

const app = hasPhoton
  ? await Spectrum({
      projectId: process.env.PROJECT_ID!,
      projectSecret: process.env.PROJECT_SECRET!,
      providers,
    })
  : await Spectrum({ providers });

const recent = new RecentBuffer(20);
const seen = new SeenSet(1000);

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

/** Run a cross-venue search and reply with the Skyscanner card (lead + body + richlink cover). */
async function replySearch(space: Space, query: string): Promise<void> {
  if (!config) return void (await space.send(needsConfig()));
  const results = await runSearch(query, { config, pmxt: pmxtConfig });
  const rendered = renderSearch(results);
  await space.send(text(rendered.lead));
  if (rendered.body) await space.send(markdown(rendered.body));
  // One native cover card for the top Sawa market (read.ts only returns public markets — no OG leak).
  if (rendered.richlinkUrl) await space.send(richlink(rendered.richlinkUrl));
}

/** Slash-command fallback (power users + the terminal TUI). */
async function handleSlash(space: Space, cmd: string, arg: string): Promise<void> {
  switch (cmd) {
    case "/search": {
      if (!arg) return void (await space.send("Usage: /search <topic>"));
      await replySearch(space, arg);
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
        `💡 (demo) ${payload.guidance}\n` +
          `Context: ${payload.messages.length} recent message(s); ${markets.length} open markets in snapshot.`,
      );
      return;
    }
    default:
      await space.send(HELP);
  }
}

/** Natural-language path: classify intent (regex-first, LLM only when unsure), then route. */
async function handleNatural(space: Space, body: string): Promise<void> {
  const intent = await parseIntent(body, botName, intentConfig);
  if (intent.kind === "search" && intent.query) {
    await replySearch(space, intent.query);
    return;
  }
  // Not a search (greeting / create / account / help) — nudge toward what this face does.
  await space.send(
    `I find prediction markets across Sawa, Kalshi & Polymarket. ` +
      `Try "${botName} FIFA World Cup" or /help.`,
  );
}

// Startup outbound initiation (SAWA_HELLO_TO="+15551234567", or a comma-separated list of handles).
// The bot messages the handle(s) FIRST. Rationale: on a Photon *shared pool*, the inbound→SDK route for a
// given end user is established when the project initiates the conversation to that registered user — a user
// who only ever cold-texts a pool line it was never addressed from may not be routed back to the stream
// (fits "Delivered, no reply"). It also converts an opaque "no inbound" into a concrete OUTBOUND result in
// our own logs: a thrown "Target not allowed for this project" pinpoints a handle/Users-allowlist mismatch
// (verify the real sending handle at https://debug.photon.codes).
async function sendHello(handles: string[]): Promise<void> {
  if (!hasPhoton) {
    console.warn("[sawa] SAWA_HELLO_TO is set but iMessage is DISABLED (no PROJECT_ID/PROJECT_SECRET) — skipping.");
    return;
  }
  const im = imessage(app);
  for (const handle of handles) {
    try {
      const user = await im.user(handle);
      const dm = await im.space.create(user);
      await dm.send(
        `👋 Sawa here. Reply with "${botName} FIFA World Cup" (or "${botName} <any topic>") and I'll find ` +
          `markets across Sawa, Kalshi & Polymarket. ${DISCLAIMER}`,
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
  hasPhoton
    ? "[sawa] listening — text the Photon line NOW; expect '⟵ inbound [iMessage/dm]' within a few seconds."
    : "[sawa] listening on terminal only.",
);

for await (const [space, message] of app.messages) {
  // Logged for EVERY event before any filtering — the definitive "did Photon deliver anything" probe.
  console.warn(`[sawa] ⟵ event [${message.platform}] type=${message.content.type}`);
  if (message.content.type !== "text") continue; // v1: text only (poll/reaction land later)

  const body = message.content.text.trim();
  if (!body) continue;
  const senderId = message.sender?.id ?? "unknown";
  const isSlash = body.startsWith("/");
  const isGroup = isGroupSpace(space, message);

  // Operational visibility: prove inbound delivery per platform (esp. for debugging the iMessage line).
  console.warn(`[sawa] ⟵ inbound [${message.platform}/${isGroup ? "group" : "dm"}] "${body.slice(0, 40)}"`);

  if (!shouldHandle({ isGroup, isSlash, body, botName })) {
    // Bystander chatter in a group — feed the buffer (for future reply-driven suggestions), no reply.
    console.warn(`[sawa] ⊘ ignored — not addressed (in a group, lead with "${botName} …" or @${botName}).`);
    recent.push(senderId, body);
    continue;
  }

  // Idempotency: at-least-once delivery → never act twice on the same message id.
  if (seen.seen(message.id)) continue;

  await space.responding(async () => {
    try {
      if (isSlash) {
        const parts = body.split(/\s+/);
        const cmd = (parts[0] ?? "").toLowerCase();
        const arg = parts.slice(1).join(" ").trim();
        await handleSlash(space, cmd, arg);
      } else {
        await handleNatural(space, body);
      }
    } catch (err) {
      console.error(`[sawa] handler failed:`, err);
      await space.send("Sorry — Sawa is unreachable right now. Try again shortly.");
    }
  });
}
