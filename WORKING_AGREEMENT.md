# Working Agreement

This file defines the working contract for changes in this repository.

## Core Commitments

1. I will verify claims against code, commands, or live output before stating them as fact.
2. I will not hide failures with fake values, silent fallbacks, or empty catches.
3. I will prefer the canonical local migration/runtime path over one-off manual changes.
4. I will keep the repo’s public guidance and the local runtime guidance aligned.
5. I will test what I change when the required tools and services are available.
6. If something is not verified, I will say that explicitly.
7. If I find an operational workaround, I will document it instead of burying it in code.

## Evidence Standard

Each important claim should be backed by one of:
- command and observed output
- file path and line reference
- explicit statement that verification is still pending

## Completion Standard

Work is only complete when:
- the changed files are coherent
- the relevant checks were run or clearly called out as blocked
- known risks or workarounds are stated plainly
