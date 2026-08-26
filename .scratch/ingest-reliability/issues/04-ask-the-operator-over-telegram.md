# 04 — Ask the operator over Telegram when a message is stuck

Status: needs-triage

## Summary

`--give-up` exists and nobody will ever run it. A stuck message sits in a list on
one machine that an operator has no reason to open. The decision the design
deliberately reserves for a human (ADR-0010) therefore never gets made, and the
message retries once a day forever.

Push it instead: when a message has been stuck long enough to matter, ask.

## What was decided

Settled in a grilling session on 2026-08-25. Each of these is a decision, not a
preference — the reasoning matters more than the conclusion.

**The notification carries no subject and no sender.** Date, stage, error,
attempt count.

Mail currently never leaves the box: `docs/48` records "`luchoh` brain stays
`private_local`" as a baked-in operator decision, and mail lands in that brain.
The existing Telegram review flow is *not* a precedent — it echoes back captures
that originated in Telegram, so nothing has ever crossed that did not start
there.

⚠️ **"No subject and no sender" is narrower than "no email content", and the
difference is not cosmetic.** Docling's error text embeds the attachment
filename — `Docling chunking failed for Q4-payroll-final.xlsx: ...` — and ingest
errors can carry response bodies. A filename is mail content by any reasonable
reading. So either the error is redacted before it crosses, or this decision is
stated honestly as "no subject or body, but filenames may travel". **Unresolved;
decide before building.** Caught in review on 2026-08-25, after the original
wording claimed more than it delivered.

**It nags daily until answered.** Not once-and-silent. An unanswered notification
returns tomorrow — the nagging is the pressure to decide, and a channel that
gives up on you is one you stop reading.

**"Dismiss" means "not now".** It clears today's card; tomorrow it's back. There
is no mute. The only exits are giving up or the message starting to work.

**Silence never decides anything.** No timeout, no "give up after N days
unanswered". That is ADR-0010's inference wearing a nicer interface, and it is
called out explicitly in that ADR because it will be tempting.

**One notification per message. No digest.** Thirty stuck messages should feel
like thirty alarms — a digest would hide exactly the signal worth seeing. If a
digest is ever needed, the volume is the problem, not the presentation.

**It starts after 12 hours stuck.** Five attempts by then (backoff lands attempt
5 at 7.8h and attempt 6 at 15.8h), which spans any plausible outage. Time rather
than attempt count, so it survives future changes to the backoff curve.

**The decision travels through Postgres, via the MCP server** — ADR-0011. Not a
shared file, not two writers on one file, not one daemon shelling out to another.
All three were considered and rejected as mechanism invented to avoid moving the
state somewhere it belongs.

**The bridge sends and receives.** Not a preference: only one process may poll a
bot token — Telegram returns 409 Conflict to a second consumer — so the button
tap can only ever arrive at the bridge, whoever sent the card. Giving the mail
importer its own token would mean two pollers fighting, or a second bot.

## A contradiction that had to be resolved

A vague notification and "act in your mail client" do not compose: if the message
is never named, it cannot be found to flag. That was resolved by the move to
Postgres — the decision is a tap on a card that already knows which message it
is, so nothing has to be located and no subject has to travel.

Recorded because it will look like an arbitrary pair of choices otherwise.

## What this is worth

`--give-up` without this is a flag with no plausible caller. With it, the one
judgement the design reserves for a human actually reaches the human, roughly
half a day after a message gets stuck, at the cost of a notification that says
almost nothing about the mail.

## Still open

- **Endpoint shape.** Something like list-stuck and record-decision. Does the
  daemon POST failures, or does the server derive them from ingest attempts?
- **Cross-boundary identity.** `imap:unparsed:<acct>:<mailbox>:<uidvalidity>:<uid>`
  works as a local key; whether it is the right primary key in Postgres is not
  settled.
- **Scope.** IMAP only, or shared with dictation, document import and the
  telegram bridge — all of which can fail on one item forever. Asked and never
  answered; a second adopter would teach more than speculation.
- **Bridge unavailable when a message becomes stuck.** Presumably the state sits
  in Postgres until it comes back, but the retry/notification semantics are not
  worked out.
- **A message that starts working after a notification is sent.** The card is
  live and now meaningless; does it get withdrawn, or answered into the void?

## Acceptance criteria

- [ ] A message stuck >12h produces exactly one Telegram card, then one per day
      until it is given up on or starts working
- [ ] The card contains no subject, sender, or body — and a test asserts it
- [ ] The filename question above is resolved, and whatever is decided is what
      the card actually does — asserted by a test using a Docling error, not a
      synthetic string
- [ ] Tapping "give up" marks it terminal; the daemon stops retrying next cycle
- [ ] "Dismiss" clears the card and it returns the following day
- [ ] Never answering changes nothing, forever — asserted by a test, because this
      is the specific failure mode ADR-0010 warns about
- [ ] Neither daemon holds a database credential (ADR-0011)
- [ ] Giving up remains possible from the command line for an operator with no
      Telegram

## Depends on

`.scratch/ingest-reliability/issues/02` (detection) overlaps: this *is* alerting,
narrowed to one decision. Worth checking whether 02 is subsumed or still distinct
before either is built.

## Comments
