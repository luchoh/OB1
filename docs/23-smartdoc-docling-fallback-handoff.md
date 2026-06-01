# Smartdoc Docling Fallback Handoff

Status: Investigated; system-config handoff; OB1 compatibility cleanup applied

Date: 2026-04-16

## Scope

This note explains why `smartdoc-markdown` fails on the OCR-heavy / scan-heavy PDF subset in the Quantum corpus and what appears to be wrong in `system-config`.

This is a forensics handoff only.

- No changes were made to `/Users/luchoh/Dev/system-config`.
- The evidence here combines source inspection in `system-config` with live service probes through Consul.

## OB1 Relevance

This is related to OB1, but not because OB1's document importer calls the stale `smartdoc-markdown` `/convert` contract.

Current OB1 document import uses `recipes/shared_docling.py` to call the live Docling chunk endpoints:

- `/v1/chunk/hierarchical/file`
- `/v1/chunk/hybrid/file`

OB1 does not post `file + format=markdown` to `/convert` in the active document-import path.

The OB1 relevance is compatibility drift around the same Docling service:

- OB1 previously defaulted `DOCLING_FALLBACK_SERVICE_NAME` to `docling-markdown`, which reinforces a stale alias name even though the alias is only the raw Docling service.
- OB1's markdown artifact helper did not recognize the direct Docling convert response shape where markdown lives at `document.md_content`.

OB1 follow-up:

- Do not treat `docling-markdown` as the default fallback service in OB1 docs or defaults.
- Keep OB1's active document import on the live `/v1/chunk/.../file` endpoints.
- Parse `document.md_content` defensively when handling direct-convert Docling payloads.

The primary broken production code described below remains in `system-config`.

## Corpus Result

Golden-standard conversion output was written to:

- `/Users/luchoh/Library/Mobile Documents/com~apple~CloudDocs/_Research/_Quantum/_Golden Standard Markdown`

Conversion rule used:

- prefer PDF when present
- else reuse existing `.md`
- else convert DOCX

Observed result:

- `189` selected inputs
- `164` successful outputs
- `25` failed PDFs

Artifacts:

- manifest: `/Users/luchoh/Library/Mobile Documents/com~apple~CloudDocs/_Research/_Quantum/_Golden Standard Markdown/_conversion_manifest.json`
- failed list: `/Users/luchoh/Library/Mobile Documents/com~apple~CloudDocs/_Research/_Quantum/_Golden Standard Markdown/_failed_pdfs.txt`
- forensics JSON: `/Users/luchoh/Library/Mobile Documents/com~apple~CloudDocs/_Research/_Quantum/_Golden Standard Markdown/_conversion_forensics.json`

## Key Conclusion

The primary defect is not host placement and not lack of M3 capacity.

The primary defect is that `smartdoc-markdown` is wired to an obsolete Docling fallback contract:

- wrong path
- wrong request shape
- wrong response parsing

The failing PDFs are exactly the class that causes `smartdoc-markdown` to invoke that fallback path.

## Service Topology

Consul resolution shows:

- node name: `m2maxstudio`
- node LAN: `10.10.10.100`
- actual service address for `docling`: `10.10.10.101:5001`
- actual service address for `smartdoc-markdown`: `10.10.10.101:5011`

Reverse DNS for `10.10.10.101` resolves to:

- `m3ultramacstudio.luchoh.net`

`smartdoc-markdown` successful responses also reported:

- `source_host: "m3ultrastudio"`

Operational meaning:

- the services are currently serving from the M3 Ultra host
- the Consul node naming / registration topology is confusing, but it is not the reason these 25 files fail

## Source-Level Root Cause

### 1. Smartdoc is configured to use `docling-markdown` via `/convert`

In `system-config`:

- `/Users/luchoh/Dev/system-config/hosts/services/m3ultrastudio/smartdoc-markdown.nix`
- `/Users/luchoh/Dev/system-config/modules/smartdoc-markdown/default.nix`
- `/Users/luchoh/Dev/system-config/modules/smartdoc-markdown/server.py`

Relevant behavior:

- `docling.serviceName = "docling-markdown"`
- `docling.path` defaults to `"/convert"`
- fallback request posts `file` and `format=markdown`
- response parser expects a top-level `.markdown` field

### 2. `docling-markdown` is only a Consul alias of the normal Docling service

In:

- `/Users/luchoh/Dev/system-config/hosts/services/m3ultrastudio/docling.nix`

The alias:

- reuses the same service on port `5001`
- does not create a dedicated markdown adapter
- does not create a compatibility `/convert` endpoint

### 3. Live Docling does not expose `/convert`

Live openapi on the resolved `docling` service exposes:

- `/v1/convert/file`
- `/v1/chunk/hierarchical/file`
- `/v1/chunk/hybrid/file`

It does not expose:

- `/convert`

Direct live probe:

- `POST /convert` returned `404 {"detail":"Not Found"}`

### 4. The live Docling response shape is also different

Live `POST /v1/convert/file` returns markdown under:

- `document.md_content`

That does not match the current `smartdoc-markdown` parser, which looks for:

- top-level `markdown`

## Why These PDFs Trigger The Broken Path

`smartdoc-markdown` routes pages to OCR fallback when they look OCR-needed.

In:

- `/Users/luchoh/Dev/system-config/modules/smartdoc-markdown/server.py`

Current classifier logic includes:

- `char_count < 20`
- `image_heavy`
- `suspicious_ratio >= 0.25`

When that triggers, `strategy = "ocr"` and smartdoc calls the broken Docling fallback contract.

## Failure Profile

Observed failures:

- `24` PDFs failed with:
  - `502 ... docling_error ... HTTP 404`
- `1` PDF failed with:
  - `400 ... encrypted_pdf`

Most failures are scan-heavy or hybrid PDFs.

Common structural signals in the failed set:

- `image ~= page_count`
- `CCITTFaxDecode` present on many or all pages
- zero or near-zero font resources
- mixed image/text hybrids that still require OCR on some pages

Examples:

- `PEAR/1979-precognitive-remote-viewing-stanford.pdf`
  - `14` pages
  - `14` images
  - `14` `CCITTFaxDecode`
  - `0` fonts
- `Scott Wilber/Papers/Patents/US06324558.pdf`
  - `31` pages
  - `31` images
  - `31` `CCITTFaxDecode`
  - `0` fonts
- `PEAR/2005-consciousness-information-living-systems.pdf`
  - encrypted

These are exactly the files that should fall through to a working OCR/Docling path.

## Critical Live Proof

The Docling service itself can process at least part of this failing set when called through its real API.

Direct live probes to `POST /v1/convert/file` succeeded for:

- `Scott Wilber/Papers/Patents/US06324558.pdf`
  - succeeded in about `98s`
- `PEAR/1979-precognitive-remote-viewing-stanford.pdf`
  - succeeded in about `122s`

That materially changes the diagnosis:

- the M3-hosted Docling service is capable of handling the files
- the main failure is the stale smartdoc-to-docling integration

## Secondary Drift

The Home Manager helper is stale in the same way.

In:

- `/Users/luchoh/Dev/system-config/modules/home-manager/default.nix`

`docling-md` still:

- defaults to `--path /convert`
- posts `format=markdown`

So both the smartdoc service and the helper still assume an older Docling markdown contract.

## Likely Fix Scope In `system-config`

### Smartdoc

Update `smartdoc-markdown` fallback to target the live Docling API, not the legacy `/convert` shim.

Likely targets:

- `/Users/luchoh/Dev/system-config/modules/smartdoc-markdown/default.nix`
- `/Users/luchoh/Dev/system-config/modules/smartdoc-markdown/server.py`
- `/Users/luchoh/Dev/system-config/hosts/services/m3ultrastudio/smartdoc-markdown.nix`

The likely changes are:

- stop defaulting to `docling.path = "/convert"`
- call live Docling endpoint(s), most likely `/v1/convert/file`
- send the request shape that live Docling expects
- parse `document.md_content`

### Helper

Update:

- `/Users/luchoh/Dev/system-config/modules/home-manager/default.nix`

So `docling-md` also targets the live Docling API instead of `/convert`.

### Naming

Optional cleanup:

- `docling-markdown` is currently just an alias for the raw Docling service
- the alias name implies a wrapper/adapter that does not exist

That naming drift is not the immediate bug, but it is part of why the stale contract survived.

## Non-Fixes

These are not the main problem:

- moving the workload off M2 and onto M3
- adding more OCR files to smartdoc without fixing the fallback contract
- using `smartdoc-sanitize`

The service is already on the M3 host.

## Remaining Edge Case

Encrypted PDFs are still blocked by smartdoc preflight:

- `/Users/luchoh/Dev/system-config/modules/smartdoc-markdown/server.py`

That is a separate feature gap from the fallback mismatch.

## Recommended Validation After Fix

After patching `system-config`, validate with at least:

1. `POST /convert-smart` on one direct text-layer PDF that already succeeds now.
2. `POST /convert-smart` on one previously failing PEAR scan-heavy PDF.
3. `POST /convert-smart` on one previously failing patent PDF.
4. `docling-md` on one of the same failing PDFs.
5. Verify that smartdoc metadata reports `docling_fallback_count > 0` on the rescued files.
6. Re-run the `25` files listed in:
   - `/Users/luchoh/Library/Mobile Documents/com~apple~CloudDocs/_Research/_Quantum/_Golden Standard Markdown/_failed_pdfs.txt`

Expected outcome after fix:

- most or all `404`-class failures should become recoverable
- encrypted PDFs will still fail until encryption handling is added
