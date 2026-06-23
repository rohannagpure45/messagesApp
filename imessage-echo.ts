/**
 * Minimal Spectrum iMessage echo — an ISOLATION test for "is Photon delivering inbound at all?"
 *
 * It strips away ALL of the Sawa bot (intent, search, pmxt, routing, lock, terminal) down to the
 * documented quickstart: connect iMessage, log every inbound event, echo text. If you text the line
 * and see NOTHING here, the problem is Photon-side inbound delivery (not our code). If you DO see
 * "⟵ EVENT", then inbound works and the bug is in the main bot.
 *
 * Run it ALONE — stop the main bot first (Ctrl+C), then:  npx tsx imessage-echo.ts
 */
import "./src/env";
import net from "node:net";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

if (!process.env.PROJECT_ID || !process.env.PROJECT_SECRET) {
  console.error("[echo] PROJECT_ID/PROJECT_SECRET missing from .env — cannot test iMessage.");
  process.exit(1);
}

// Share the main bot's single-instance lock so this can't silently duel with it over the Photon line.
await new Promise<void>((resolve) => {
  const lock = net.createServer();
  lock.unref();
  lock.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error("[echo] ✋ The main bot is still running — stop it first (Ctrl+C), then re-run the echo alone.");
      process.exit(1);
    }
    resolve();
  });
  lock.listen(Number(process.env.SAWA_LOCK_PORT) || 47615, "127.0.0.1", () => resolve());
});

const app = await Spectrum({
  projectId: process.env.PROJECT_ID,
  projectSecret: process.env.PROJECT_SECRET,
  providers: [imessage.config()],
});

console.warn("[echo] connected — text the Photon line NOW. Every inbound event is logged; text is echoed.");

for await (const [space, message] of app.messages) {
  // Logged for EVERY event, before any filtering — the definitive "did Photon deliver?" probe.
  console.warn(
    `[echo] ⟵ EVENT platform=${message.platform} type=${message.content.type} from=${message.sender?.id ?? "?"}`,
  );
  if (message.content.type === "text") {
    await space.send(`echo: ${message.content.text}`);
    console.warn("[echo] ⟶ echoed back");
  }
}
