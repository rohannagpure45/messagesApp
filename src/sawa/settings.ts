/**
 * Natural-language AGENT SETTINGS — toggle the bot's behavior from chat the same way markets are
 * searched, e.g. "sawa quips off", "sawa sawa only", "sawa settings". A small, extensible registry:
 * each setting owns its on/off phrasings + confirmation copy, so adding one is a single entry plus an
 * application point at the reply site. State is per-space and IN-MEMORY (no DB — the Sawa no-writes
 * invariant), seeded from env defaults; a process restart reverts to those defaults by design,
 * matching every other piece of bot state (ConversationStore, SeenSet).
 *
 * Two seams keep it robust against the search path:
 *  - The recognizer requires BOTH a setting subject AND an explicit direction token, so an incidental
 *    mention ("odds on a comedian's quips") is never mistaken for a toggle (precision over recall — a
 *    missed toggle just gets rephrased; a false toggle silently changes behavior).
 *  - `peelSettings` consumes LEADING settings clauses off a compound message ("turn on the quips,
 *    look for X") and returns the remainder, so the toggle is applied and never searched — this closes
 *    the documented Issue-5 symptom (SEARCH_FIXES.md §5), not just the standalone case.
 */

import fs from "node:fs";
import path from "node:path";

/** The agent settings that can be toggled by chat. Add a key + a SETTINGS entry + an apply site. */
export type SettingKey = "quips" | "external";

export interface SettingChange {
  key: SettingKey;
  on: boolean;
}

interface SettingSpec {
  key: SettingKey;
  /** Human label for the settings READ reply. */
  label: string;
  /** Confirmation copy. */
  onReply: string;
  offReply: string;
  /** A short address-stripped clause that turns the setting ON / OFF. */
  on: RegExp;
  off: RegExp;
}

// --- subject vocab, assembled into per-setting matchers ---------------------------------------

const QUIP = "(?:quips?|jokes?|banter|folk[\\s-]?tone|flair|flourish|sass|personality|humou?r)";
// External-venue subjects are kept NON-COLLIDING with the venue link follow-ups: a bare "kalshi"
// (a link request) has no direction token, so it is never read as a toggle — only "kalshi off" is.
const EXT = "(?:external(?:\\s+markets?)?|other\\s+venues?|kalshi|polymarket)";

/** Wrap a clause body: anchored, tolerant of a polite prefix + trailing punctuation. */
function clause(body: string): RegExp {
  return new RegExp(
    `^(?:please\\s+|can\\s+you\\s+|could\\s+you\\s+|pls\\s+|hey\\s+|just\\s+)*(?:${body})[\\s!.?]*$`,
    "i",
  );
}

const SETTINGS: SettingSpec[] = [
  {
    key: "quips",
    label: "quips",
    onReply: "Quips on — I'll add a little color.",
    offReply: "Quips off — just the facts.",
    on: clause(
      `(?:turn(?:\\s+on)?|switch(?:\\s+on)?|flip(?:\\s+on)?|put(?:\\s+on)?|enable|activate|add|more)\\s+(?:the\\s+|some\\s+)?${QUIP}(?:\\s+on)?` +
        `|(?:the\\s+)?${QUIP}\\s+(?:on|please|enabled?)` +
        `|on\\s+${QUIP}`,
    ),
    off: clause(
      `(?:turn(?:\\s+off)?|switch(?:\\s+off)?|flip(?:\\s+off)?|disable|deactivate|stop|kill|mute|silence|cut|drop|less|no)\\s+(?:the\\s+|those\\s+|all\\s+the\\s+)?${QUIP}(?:\\s+off)?` +
        `|(?:the\\s+)?${QUIP}\\s+(?:off|disabled?)` +
        `|off\\s+${QUIP}` +
        `|no\\s+more\\s+${QUIP}`,
    ),
  },
  {
    key: "external",
    label: "external markets",
    onReply: "External markets on — Kalshi & Polymarket included.",
    offReply: "Sawa only — external markets off.",
    on: clause(
      `all\\s+venues|every\\s+venue|${EXT}\\s+on` +
        `|(?:turn\\s+on|switch\\s+on|enable|include|add|unhide)\\s+(?:the\\s+)?${EXT}`,
    ),
    off: clause(
      `sawa[-\\s]?only(?:\\s+mode)?|just\\s+sawa|only\\s+sawa(?:\\s+markets?)?|${EXT}\\s+off` +
        `|(?:turn\\s+off|switch\\s+off|disable|hide|exclude|without|no|drop)\\s+(?:the\\s+)?${EXT}`,
    ),
  },
];

export const SETTING_KEYS: SettingKey[] = SETTINGS.map((s) => s.key);

/**
 * Classify ONE clause as a setting toggle, or null. OFF is tested before ON because off-cues are the
 * more specific phrasings ("turn off …" vs a bare "… on"); a clause with a subject but no direction
 * (bare "quips", "kalshi") returns null and falls through to the search/link path.
 */
export function classifySettingCommand(text: string): SettingChange | null {
  const t = text.trim();
  if (!t) return null;
  for (const s of SETTINGS) {
    if (s.off.test(t)) return { key: s.key, on: false };
    if (s.on.test(t)) return { key: s.key, on: true };
  }
  return null;
}

/** Split a compound message at the first clause boundary (comma / "and" / "then" / "&"). */
const CLAUSE_BOUNDARY = /^(.*?)(?:\s*[,;]+\s*|\s+and\s+then\s+|\s+then\s+|\s+and\s+|\s*&\s*)(.*)$/i;

/**
 * Peel LEADING settings clauses off `text`, returning the applied changes (in order) and the
 * remaining message. The moment a head is NOT a settings command the peel stops and the full
 * remainder is returned untouched — so a real search that merely contains "and"/"," ("find cap and
 * trade", "Switzerland, India") is never split. Bounded loop (at most one peel per setting + slack).
 */
export function peelSettings(text: string): { changes: SettingChange[]; rest: string } {
  const changes: SettingChange[] = [];
  let rest = text.trim();
  for (let i = 0; i < SETTING_KEYS.length + 2 && rest; i++) {
    const m = rest.match(CLAUSE_BOUNDARY);
    const head = (m ? m[1]! : rest).trim();
    const tail = (m ? m[2]! : "").trim();
    const cmd = classifySettingCommand(head);
    if (!cmd) break;
    changes.push(cmd);
    rest = tail;
  }
  return { changes, rest };
}

/** "settings" / "show settings" / "what are your settings" — a READ of the current per-space values. */
const SETTINGS_QUERY =
  /^(?:show|list|view|see|what(?:'?s| are| is)?|current|your|my)?\s*(?:my\s+|the\s+|current\s+|your\s+)*settings\b[\s!.?]*$/i;
export function isSettingsQuery(text: string): boolean {
  return SETTINGS_QUERY.test(text.trim());
}

// --- durable per-space store ------------------------------------------------------------------

/** On-disk shape: spaceId -> { setting -> bool }. Unknown/removed keys are ignored on load. */
export type SettingsSnapshot = Record<string, Partial<Record<SettingKey, boolean>>>;

/** Pluggable persistence so the store survives restarts (and so tests can inject a fake). */
export interface SettingsPersistence {
  load(): SettingsSnapshot | null;
  save(data: SettingsSnapshot): void;
}

/**
 * JSON-file persistence. This is BOT-LOCAL state (the bot's own UX preferences on the host's disk) —
 * NOT a Sawa write: the no-writes invariant governs the Sawa Postgres / bot API, not a local
 * preference file. Writes are atomic (temp file + rename) and fully fail-soft: a read/write error
 * degrades to in-memory (or env defaults) and never crashes the bot.
 */
export function fileSettingsPersistence(filePath: string): SettingsPersistence {
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8")) as SettingsSnapshot;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(`[settings] could not read ${filePath} (${(err as Error).message}) — using env defaults.`);
        }
        return null; // missing file on first run is normal
      }
    },
    save(data) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, filePath); // atomic replace
      } catch (err) {
        console.warn(`[settings] could not persist ${filePath} (${(err as Error).message}) — change kept in memory only.`);
      }
    },
  };
}

/**
 * Sticky per-space setting overrides. DURABLE: with a `persist` adapter the per-space values are
 * written through to disk on every change and rehydrated on startup, so a toggle in a group sticks
 * for days/weeks until changed again — surviving restarts (Spectrum offers no server-side state, but
 * the bot owns its host's filesystem). The env defaults only seed a space that has NEVER been set.
 * NO TTL (a preference must not silently revert mid-session, unlike a stale candidate list); a high
 * LRU cap is a pure runaway backstop (eviction never fires at real scale, so persisted prefs stay).
 * Without a `persist` adapter it is a plain in-memory store (used by unit tests).
 */
export class SpaceSettings {
  private store = new Map<string, Map<SettingKey, boolean>>();
  private max: number;
  private persist?: SettingsPersistence;

  constructor(
    private defaults: Record<SettingKey, boolean>,
    opts: { max?: number; persist?: SettingsPersistence } = {},
  ) {
    this.max = opts.max ?? 50_000;
    this.persist = opts.persist;
    const loaded = this.persist?.load();
    if (loaded) this.hydrate(loaded);
  }

  private hydrate(snap: SettingsSnapshot): void {
    for (const [spaceId, vals] of Object.entries(snap)) {
      const m = new Map<SettingKey, boolean>();
      for (const k of SETTING_KEYS) if (typeof vals[k] === "boolean") m.set(k, vals[k]!);
      if (m.size) this.store.set(spaceId, m);
    }
  }

  private serialize(): SettingsSnapshot {
    const out: SettingsSnapshot = {};
    for (const [spaceId, m] of this.store) {
      const o: Partial<Record<SettingKey, boolean>> = {};
      for (const [k, v] of m) o[k] = v;
      out[spaceId] = o;
    }
    return out;
  }

  get(spaceId: string, key: SettingKey): boolean {
    return this.store.get(spaceId)?.get(key) ?? this.defaults[key];
  }

  set(spaceId: string, key: SettingKey, on: boolean): void {
    let m = this.store.get(spaceId);
    if (m) {
      this.store.delete(spaceId); // re-insert to refresh LRU recency
    } else {
      if (this.store.size >= this.max) {
        const oldest = this.store.keys().next().value;
        if (oldest !== undefined) this.store.delete(oldest);
      }
      m = new Map<SettingKey, boolean>();
    }
    m.set(key, on);
    this.store.set(spaceId, m);
    this.persist?.save(this.serialize()); // write through so the change survives a restart
  }

  /** The resolved view (override ?? default) of every setting for a space — for the READ reply. */
  resolved(spaceId: string): Record<SettingKey, boolean> {
    const out = {} as Record<SettingKey, boolean>;
    for (const k of SETTING_KEYS) out[k] = this.get(spaceId, k);
    return out;
  }
}

// --- reply copy -------------------------------------------------------------------------------

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s] as const));

/** Confirmation for one or more applied changes, in order (a compound toggles several at once). */
export function confirmChanges(changes: SettingChange[]): string {
  return changes.map((c) => (c.on ? BY_KEY.get(c.key)!.onReply : BY_KEY.get(c.key)!.offReply)).join(" ");
}

/** The settings READ reply: current per-space values + a usage hint. */
export function describeSettings(resolved: Record<SettingKey, boolean>): string {
  const parts = SETTINGS.map((s) => `${s.label}: ${resolved[s.key] ? "on" : "off"}`);
  return `Settings — ${parts.join(", ")}. Toggle by chat, e.g. "quips off" or "sawa only".`;
}
