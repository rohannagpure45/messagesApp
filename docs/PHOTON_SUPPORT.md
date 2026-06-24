# Photon support report — shared-pool line dead in BOTH directions (ready to send)

**Send to:** `ryan@photon.codes` (per the Spectrum docs support contact).

**Status (verified 23-Jun against the user's own Messages database):** this is **conclusively a Photon-side
line problem**, not the integration. The shared-pool line **+1 (628) 264-7704** moves **no iMessage in either
direction** for this project, even though the SDK control connection is healthy and the line is a valid
registered iMessage handle. Specifics proven below. Code/SDK/network/handle/binding are all disproven.

**Optional 60-second pre-check (cheap, do it but it likely won't change the diagnosis):** open
**[debug.photon.codes](https://debug.photon.codes)** on the iPhone and confirm the handle it reports matches
the Users page. (We already have strong evidence the handle is fine — a bot-initiated send to it was accepted
with no "Target not allowed" — but this rules out the last user-side variable.)

---

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
