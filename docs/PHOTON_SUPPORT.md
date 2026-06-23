# Photon support report — iMessage inbound not delivered (ready to send)

**Send to:** `ryan@photon.codes` (per the Spectrum docs support contact).
**Also try first:** on [app.photon.codes](https://app.photon.codes), **remove + re-add your phone** on the
Users page and **re-provision/re-assign the shared-pool line** — Photon's own troubleshooting maps the exact
symptom below ("connected, no inbound") to line provisioning. If that fixes it, you don't need this.

---

## Copy-paste email

> **Subject:** iMessage inbound not delivered to connected SDK client (project `sawagc`)
>
> Hi — my Spectrum bot connects to the cloud and stays connected, but **inbound iMessage texts never reach the
> SDK's `app.messages` stream**. Outbound/connection are healthy; only inbound is missing. Details:
>
> - **Project:** `sawagc` (Free plan, shared-pool line **+1 (628) 264-7704**).
> - **My phone is added** on the Users page; texting the line shows **"Delivered"**, but the bot logs **no
>   inbound event** at all (I log every event before any filtering).
> - **Connection is healthy and stable:** a persistent TLS socket to your prod cluster
>   (`*.elb.us-west-1.amazonaws.com`), unchanged across several minutes with **zero reconnect/error churn** in
>   the verbose SDK logs.
> - **Tested on `spectrum-ts` 4.2.0 AND 5.2.0** — identical: connects, `Spectrum started`, but receives nothing.
> - **Single instance** (I added a single-instance lock to rule out duplicate clients dueling over the line).
> - **No webhook configured** (so inbound isn't being diverted off the stream).
> - The **terminal provider receives inbound fine** over the same `app.messages` iterator, so my consumption
>   of the stream is correct — the gap is specifically iMessage inbound delivery from your side.
>
> It looks like inbound isn't being **routed/provisioned** to my connected client for this shared-pool line.
> Could you check whether inbound for **+1 (628) 264-7704** is provisioned to my project's session, and
> whether my phone's mapping to that line is active? Happy to provide logs / project id. Thanks!

---

## Evidence appendix (if they ask)

| Check | Result |
|---|---|
| `iMessage: ENABLED` (PROJECT_ID + PROJECT_SECRET present) | ✅ |
| Instances running | exactly 1 (single-instance lock on `127.0.0.1:47615`) |
| Socket to Photon | ESTABLISHED, stable, `*.elb.us-west-1.amazonaws.com:443` |
| Reconnect/error churn over ~100s | none |
| Per-event inbound log (`⟵ event`) on text | never fires for iMessage |
| Terminal provider inbound (same iterator) | works |
| SDK versions tested | spectrum-ts 4.2.0 and 5.2.0 |
| Webhook configured | no |
| Intent/search pipeline | works (verified in terminal + against live Sawa/Kalshi/Polymarket APIs) |

**Repro with the smallest surface:** `npx tsx imessage-echo.ts` (a 15-line stock echo in this repo) reproduces
identically — connects, receives no inbound. A fresh `bun create spectrum-project@latest` echo on the same
account is the cleanest control; if it also receives nothing, the issue is entirely account/line-side.
