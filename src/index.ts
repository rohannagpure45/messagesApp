/**
 * Sawa discovery bot on Photon Spectrum.
 *
 * One handler against `app.messages`, delivered across every configured provider
 * (iMessage in production, terminal for dev). Read-only by construction.
 */
import "./env"; // MUST be first: loads ./.env into process.env before anything reads it.

import { Spectrum, text, richlink } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";

import { getConfig, ConfigError, type Config } from "./sawa/config";
import { listMarkets, getMarket } from "./sawa/read";
import { formatList, formatMarket } from "./sawa/format";
import { stubCreate } from "./sawa/createStub";
import { RecentBuffer, suggestPayload } from "./sawa/suggest";

const DISCLAIMER = "Virtual Sawa coins — entertainment only, no cash value.";
const HELP = [
  "Sawa discovery bot — commands:",
  "/markets            list open markets",
  "/search <words>     search markets by title",
  "/show <id>          full detail for one market",
  "/create <question>  preview a market (nothing is created)",
  "/suggest            ideas from recent chat",
  DISCLAIMER,
].join("\n");

// Config is required for the read commands; load once and fail soft so the TUI still boots.
let config: Config | null = null;
try {
  config = getConfig();
} catch (err) {
  if (err instanceof ConfigError) console.warn(`[sawa] read commands disabled: ${err.message}`);
  else throw err;
}

const TERMINAL_COMMANDS = [
  { name: "/markets", description: "List open markets" },
  { name: "/search", description: "Search markets by title" },
  { name: "/show", description: "Show one market by id" },
  { name: "/create", description: "Preview a market (stub — nothing created)" },
  { name: "/suggest", description: "Suggest markets from recent chat" },
  { name: "/help", description: "Show commands" },
];

const hasPhoton = Boolean(process.env.PROJECT_ID && process.env.PROJECT_SECRET);
if (!hasPhoton) {
  console.warn("[sawa] PROJECT_ID/PROJECT_SECRET unset → iMessage disabled, running terminal-only.");
}

// iMessage (cloud) only when credentials exist; terminal always (the dev TUI needs none).
const providers = [
  ...(hasPhoton ? [imessage.config()] : []),
  terminal.config({ commands: TERMINAL_COMMANDS }),
];

const app = hasPhoton
  ? await Spectrum({
      projectId: process.env.PROJECT_ID!,
      projectSecret: process.env.PROJECT_SECRET!,
      providers,
    })
  : await Spectrum({ providers });

const recent = new RecentBuffer(20);

function needsConfig(): string {
  return "Sawa reads aren't configured (set SAWA_API_BASE_URL).";
}

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") continue;

  const body = message.content.text.trim();
  const senderId = message.sender?.id ?? "unknown";

  // Non-commands feed the rolling buffer that /suggest reasons over.
  if (!body.startsWith("/")) {
    recent.push(senderId, body);
    continue;
  }

  const parts = body.split(/\s+/);
  const cmd = (parts[0] ?? "").toLowerCase();
  const arg = parts.slice(1).join(" ").trim();

  await space.responding(async () => {
    try {
      switch (cmd) {
        case "/markets": {
          if (!config) return void (await space.send(needsConfig()));
          await space.send(formatList(await listMarkets(config, { limit: 10 })));
          return;
        }
        case "/search": {
          if (!config) return void (await space.send(needsConfig()));
          if (!arg) return void (await space.send("Usage: /search <words>"));
          await space.send(formatList(await listMarkets(config, { search: arg, limit: 10 })));
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
          const payload = suggestPayload(markets, recent.recent(senderId));
          await space.send(
            `💡 (demo) ${payload.guidance}\n` +
              `Context: ${payload.messages.length} recent message(s); ${markets.length} open markets in snapshot.`,
          );
          return;
        }
        default:
          await space.send(HELP);
      }
    } catch (err) {
      console.error(`[sawa] ${cmd} failed:`, err);
      await space.send("Sorry — Sawa is unreachable right now. Try again shortly.");
    }
  });
}
