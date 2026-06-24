# Photon support — line correspondence

**Send to:** `ryan@photon.codes` (per the Spectrum docs support contact).

> **CURRENT (24-Jun): the 23-Jun "dead line" issue is RESOLVED.** Shared-pool line **+1 (628) 264-7704**
> now routes DMs both directions and the `sawagc` bot is live in 1:1 chats. The active ask is a **dedicated
> Business line for GROUP chat** (groups don't route on the shared pool) — send the **24-Jun follow-up**
> below. The 23-Jun "dead in both directions" report that follows is kept for history; its conclusion no
> longer applies (the line now works for DMs).

**Optional 60-second pre-check (cheap, do it but it likely won't change the diagnosis):** open
**[debug.photon.codes](https://debug.photon.codes)** on the iPhone and confirm the handle it reports matches
the Users page. (We already have strong evidence the handle is fine — a bot-initiated send to it was accepted
with no "Target not allowed" — but this rules out the last user-side variable.)

---

## 24-Jun follow-up — request a dedicated Business line for groups (SEND THIS)

> **Subject:** Re: shared-pool line +1 628 264-7704 — resolved; requesting a dedicated Business line for groups
>
> Hi Ryan,
>
> Two things — an update and a follow-up ask.
>
> **Resolved:** the earlier "no iMessage in either direction" problem on shared-pool line **+1 (628)
> 264-7704** has cleared. DMs now route both ways and my Spectrum bot (`sawagc`) is live in 1:1 chats
> (natural-language prediction-market search across Sawa, Kalshi & Polymarket). Thanks for the help.
>
> **New ask — a dedicated (Business) line for group chat.** Groups don't work on the shared pool, which
> matches your docs ("shared mode cannot create group chats"). I confirmed it live today:
> - Built a group with my line **+1 (628) 264-7704** + one other member, with the bot listening 28 min.
> - A fresh group message produced **zero inbound** to the SDK (I log every event before filtering), while
>   DMs to the same line in the same window routed fine.
> - So the shared pool can't present one coherent bot number to a group (each end user routes through a
>   different pool number).
>
> Could you move `sawagc` to a **dedicated Business line** so group chats work? Happy to do whatever's
> needed on my end.
>
> **One more data point (possibly related):** today I also saw intermittent **outbound** errors on the
> line — `SendTextMessage DEADLINE_EXCEEDED` and `SetTyping ECONNRESET` ("[upstream] Service temporarily
> unavailable, please retry"). The text usually still delivers (the ack just times out), but it's frequent
> enough to flag. Known transient issue, or worth rotating the line as part of the Business move?
>
> Thanks!
> — Rohan · project `sawagc`

---

## Historical (23-Jun — RESOLVED): "line dead in both directions" report

_Kept for the evidence trail. The line now routes DMs both ways, so the "dead line" conclusion below no
longer applies; the data remains useful context for the line's history._

## Copy-paste email

> **Subject:** Shared-pool line +1 628 264-7704 delivers no iMessage in either direction (project `sawagc`)
>
> Hi — my Spectrum bot keeps a healthy, stable cloud connection, but the **shared-pool line moves no iMessage
> traffic in either direction** for my project. I verified this against my Mac's own Messages database
> (`chat.db`), so the evidence is hard, not inferred:
>
> - **Project:** `sawagc` (Free plan, shared-pool line **+1 (628) 264-7704**).
> - **Outbound (bot → me) is accepted but never delivered.** I had the bot initiate a DM to my
>   allowlisted number (**+1 609 375-6850**). The SDK returned **success — no "Target not allowed"**, so the
>   line is sending on my project's behalf and my handle is allowlisted. But the message **never arrived**:
>   it is **absent from my Messages database**, which is otherwise live to the second. The line has sent my
>   number **0 messages, ever** (`is_from_me=0` count = 0 across the whole thread).
> - **Inbound (me → bot) shows "Delivered" but never reaches the SDK.** Every text I send the line shows
>   **Delivered** in Messages, but the bot logs **no inbound event** at all (I log every event before any
>   filtering, and the terminal provider receives inbound fine over the same `app.messages` iterator — so my
>   consumption of the stream is correct).
> - **The line is a valid registered iMessage handle.** In my `chat.db`, `+16282647704` resolves to
>   `service = iMessage`, `country = US`. So this isn't an SMS fallback or an unregistered number on my end.
> - **Connection is healthy and stable:** persistent TLS socket to your prod cluster
>   (`*.elb.us-west-1.amazonaws.com`), `Spectrum started`, zero reconnect/error churn over minutes.
> - **Ruled out on my side:** single instance (lock), no webhook, tested on `spectrum-ts` 4.2.0 **and** 5.2.0,
>   handle accepted by the API (the bot-initiated send didn't error).
>
> This reads like the shared-pool line is **de-registered / mis-provisioned at the Apple iMessage transport
> layer** — your API accepts sends and my SDK session is connected, but no iMessage actually flows to or from
> my user. **Could you rotate / re-provision the shared-pool line for `sawagc`** (or move me to a dedicated
> Business line)? Happy to share project id, logs, and the exact `chat.db` queries. Thanks!

---

## Evidence appendix (hard data from the user's `chat.db`, if they ask)

| Check | Result |
|---|---|
| Line `+16282647704` registration (handle table) | `service=iMessage, country=US` — valid iMessage handle |
| Messages **from** the line → me (`is_from_me=0`) | **0, ever** (line has never delivered anything) |
| Messages **from** me → the line (`is_from_me=1`) | 10 (all show "Delivered" in Messages) |
| Bot-initiated send to allowlisted **+16093756850** | SDK returned **✅ sent, no "Target not allowed"** … |
| …but that send in my Messages DB | **absent** — never delivered, DB otherwise current to the second |
| Per-event inbound log (`⟵ inbound`) on my texts | **never fires** for iMessage |
| Terminal provider inbound (same `app.messages` iterator) | works → stream consumption is correct |
| Socket to Photon prod cluster | ESTABLISHED, stable, `*.elb.us-west-1.amazonaws.com:443`, zero churn |
| SDK versions tested | spectrum-ts 4.2.0 and 5.2.0 (identical) |
| Single instance / webhook | exactly 1 (lock on `127.0.0.1:47615`) / none |
| Intent/search pipeline | works (verified in terminal + live Sawa/Kalshi/Polymarket APIs) |

**Reproduce the read yourself (read-only, needs Full Disk Access on Terminal):**
```sh
DB="$HOME/Library/Messages/chat.db"; URI="file:${DB}?mode=ro&immutable=1"
# Line is a registered iMessage handle:
sqlite3 "$URI" "SELECT id, service, country FROM handle WHERE id='+16282647704';"
# Direction breakdown — note ZERO is_from_me=0 (the line never sent anything):
sqlite3 "$URI" "SELECT m.is_from_me, count(*) FROM message m JOIN handle h ON h.ROWID=m.handle_id WHERE h.id='+16282647704' GROUP BY m.is_from_me;"
```

**Smallest repro surface:** `npx tsx imessage-echo.ts` (15-line stock echo in this repo) reproduces
identically. A fresh `bun create spectrum-project@latest` echo on the same account is the cleanest control —
if it also moves nothing, the issue is entirely the account/line, which the `chat.db` evidence already shows.
