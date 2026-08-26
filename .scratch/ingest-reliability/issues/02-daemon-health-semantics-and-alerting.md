# 02 — Ingest daemons: a service that fails and sleeps is indistinguishable from an idle one

Status: needs-triage

## Summary

The ingest daemons run on a cycle: do work, report an exit code, sleep, repeat.
Nothing consumes the exit code. A daemon that fails every single cycle looks
exactly like a healthy daemon with nothing to do — both are "running" and both
are asleep most of the time.

There is no alerting on repeated failure, and no health signal that distinguishes
*idle* from *stuck*.

## Observed evidence

`ob1-imap-watch` failed **every cycle for fourteen days** — 2026-08-11 to
2026-08-25, roughly **1,800 consecutive cycles**, each exiting non-zero with the
same error. **No alert fired. Nobody noticed.** It was found only because a
human went looking for something else.

The daemon was never down. `launchd`/service supervision was satisfied
throughout, because the process started, ran, exited its cycle and slept exactly
as designed. Liveness was green the entire time the service was doing nothing.

This is the condition that turned a parser bug into a two-week ingest outage.
Issue `01` addresses the retry loop; this issue addresses why it ran unobserved.

## Scope

Confirmed affected — all five ingest daemons share this cycle-and-sleep shape:

| Service | OB1 recipe |
| --- | --- |
| `ob1-imap-watch` | `recipes/email-history-import/import-imap.py` |
| `ob1-telegram-bridge` | `integrations/telegram-capture/telegram_bridge.py` |
| `ob1-telegram-bridge-dev` | same |
| `ob1-dictation-import` | `recipes/dictation-import/import-dictation.py` |
| `ob1-dictation-import-dev` | same |

`ob1-stable` (the MCP server) is **not** in this class — it serves `/health` and
returns 200, so it has a real readiness signal. The ingest daemons have no
equivalent.

**This issue spans two repos.** The daemons' wrappers, supervision and any
alerting live in `system-config` (`modules/ob1-imap-watch`,
`modules/ob1-telegram-bridges`, `modules/ob1-dictation-import`, with host wiring
under `hosts/services/m2maxstudio/`). The cycle summary line and exit codes are
produced by the OB1 recipes. A fix likely needs both; triage should decide which
repo owns which half.

## Operational impact

- Silent data loss with no upper bound on duration. Fourteen days here; nothing
  in the system would have stopped it being fourteen months.
- The failure is *invisible by construction* — every observable signal
  (process alive, cycle completing, service enabled) was green.
- It generalises. Any future error in any of the five daemons fails the same way,
  silently and indefinitely. Fixing issue `01` bounds the retries for one daemon;
  it does not make failure visible for any of them.

## Acceptance criteria

- [ ] Each ingest daemon exposes a machine-readable health signal that
      distinguishes at least: **healthy** (last cycle succeeded), **degraded**
      (some failures, still making progress), **stuck** (N consecutive failed
      cycles, or no successful cycle in T).
- [ ] "Stuck" is defined in terms of *consecutive failures* or *time since last
      success*, not process liveness. An idle daemon with nothing to do must
      report healthy, not stuck — the two must not be conflated in either
      direction.
- [ ] Repeated failure raises an alert that reaches the operator without them
      going to look. The delivery channel is a triage decision; the requirement
      is that discovery is not manual.
- [ ] The alert threshold is well below fourteen days. A concrete starting
      proposal: alert after 3 consecutive failed cycles, or 1 hour with no
      successful cycle, whichever is sooner.
- [ ] Last-success timestamp and consecutive-failure count are persisted across
      restarts, so a restart cannot silently reset the alarm clock.
- [ ] Alerts recover: once a cycle succeeds, the state clears and this is
      observable.
- [ ] The check is verified by deliberately breaking one daemon in a dev
      environment and confirming the alert fires — not by reading the config.
- [ ] Applied to all five services in the table above, not only `ob1-imap-watch`.

## Notes

- The cycle summary line already carries most of what is needed:
  `[2026-08-25T01:41:22Z] cycle=1 exit_code=0 elapsed_seconds=414.87` plus a
  `failures=` count. A consumer of that line may be most of the work.
- Worth deciding whether the daemons should exit non-zero *at the process level*
  on a stuck condition, so ordinary service supervision can see it, rather than
  inventing a parallel health channel.

## Comments
