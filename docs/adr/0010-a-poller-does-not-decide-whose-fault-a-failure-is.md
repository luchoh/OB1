---
status: accepted
date: 2026-08-25
---

# A poller does not decide whose fault a failure is

`ob1-imap-watch` records failures, backs them off, and lists them. It does **not**
classify them, and it never retires a message on its own authority. Terminating a
message is an operator action.

The obvious design is the opposite: work out whether a failure is the message's
fault or the world's, bound the former, retry the latter forever. Five proxies for
that judgement were built and each failed in the case it was built for:

| Proxy | How it failed |
| --- | --- |
| exception type | the 2026-08-11 incident *was* a `ValueError` |
| HTTP status | 401/403 are mailbox-wide; Docling's real junk-file path is **200 with zero chunks**, not a 4xx |
| historical "this stage was healthy" stamps | one healthy hour licenses retiring the whole mailbox during the next outage; a 24h lifetime could not expire inside the 3.75h it took to spend a five-attempt budget |
| same-cycle corroboration | comparators get skipped once ingested, so leftovers never close — 12 cycles produced 1 poison attempt |
| "this stage is local, so it must be the message" | our own parser is code, and a parser bug looks local |

Those are the available moves. The pattern is not that the problem is hard; it is
that a single cycle of a poller **cannot** distinguish "this attachment is corrupt"
from "Docling is down". The evidence does not exist inside the process.

The payoff is asymmetric. An automatic false positive strands mail silently and
permanently. The cost avoided by getting it right is one visible retry per day —
backoff alone already takes a permanently failing message from ~1,800 attempts over
fourteen days to about 20. Buying a 5% saving with a silent-data-loss risk is a bad
trade at any hit rate.

So the code records what happened — stage, HTTP status where there was one, error
text, attempt count, timestamps — and shows it to a human, who decides. `--give-up`
marks a message terminal; `--requeue` undoes it. Nothing else sets that flag, and a
test asserts that fifty consecutive failures earn a wait rather than a verdict.

The accepted cost: nothing ever terminates by itself. A message that can never be
processed retries once a day indefinitely until someone looks. That is loud,
bounded, cheap, and loses nothing — which is the direction this daemon should err
in, given it once ingested nothing for fourteen days without anyone noticing.

A corollary worth stating because it will be tempting: a notification threshold is
not a classifier, but a *timeout on the reply* would be. "Give up if the operator
does not answer within N days" is this same inference wearing a nicer interface.
