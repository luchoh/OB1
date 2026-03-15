#!/usr/bin/env bash

consul_bool_is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

consul_service_address_port() {
  local service_name="$1"

  if [[ -z "${CONSUL_HTTP_ADDR:-}" ]]; then
    echo "CONSUL_HTTP_ADDR is not set." >&2
    return 1
  fi

  SERVICE_NAME="$service_name" python3 - <<'PY'
import json
import os
import re
import ssl
import sys
import urllib.parse
import urllib.request

consul_addr = os.environ["CONSUL_HTTP_ADDR"].rstrip("/")
consul_token = os.environ.get("CONSUL_HTTP_TOKEN", "")
service_name = os.environ["SERVICE_NAME"]
skip_tls_verify = os.environ.get("CONSUL_SKIP_TLS_VERIFY", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}

headers = {}
if consul_token:
    headers["X-Consul-Token"] = consul_token

request = urllib.request.Request(
    f"{consul_addr}/v1/health/service/{service_name}?passing=1",
    headers=headers,
)

context = None
if skip_tls_verify and consul_addr.startswith("https://"):
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE

with urllib.request.urlopen(request, timeout=30, context=context) as response:
    payload = json.load(response)

if not payload:
    raise SystemExit(f"No passing Consul instances for {service_name}")

service = payload[0].get("Service", {})
node = payload[0].get("Node", {})
address = service.get("Address") or node.get("Address")
port = service.get("Port")

if not address or not port:
    raise SystemExit(f"Consul service {service_name} is missing address/port")

preferred_host = None
for tag in service.get("Tags") or []:
    match = re.search(r"Host\\(`([^`]+)`\\)", tag)
    if match:
        preferred_host = match.group(1)
        break

if not preferred_host:
    consul_host = urllib.parse.urlparse(consul_addr).hostname or ""
    parts = consul_host.split(".")
    node_name = node.get("Node")
    if node_name and "." not in node_name and len(parts) > 1:
        preferred_host = f"{node_name}.{'.'.join(parts[1:])}"

print(f"{preferred_host or address}:{port}")
PY
}

consul_service_root_url() {
  local service_name="$1"

  if [[ -z "${CONSUL_HTTP_ADDR:-}" ]]; then
    echo "CONSUL_HTTP_ADDR is not set." >&2
    return 1
  fi

  SERVICE_NAME="$service_name" python3 - <<'PY'
import json
import os
import re
import ssl
import urllib.parse
import urllib.request

consul_addr = os.environ["CONSUL_HTTP_ADDR"].rstrip("/")
consul_token = os.environ.get("CONSUL_HTTP_TOKEN", "")
service_name = os.environ["SERVICE_NAME"]
skip_tls_verify = os.environ.get("CONSUL_SKIP_TLS_VERIFY", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}

headers = {}
if consul_token:
    headers["X-Consul-Token"] = consul_token

request = urllib.request.Request(
    f"{consul_addr}/v1/health/service/{service_name}?passing=1",
    headers=headers,
)

context = None
if skip_tls_verify and consul_addr.startswith("https://"):
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE

with urllib.request.urlopen(request, timeout=30, context=context) as response:
    payload = json.load(response)

if not payload:
    raise SystemExit(f"No passing Consul instances for {service_name}")

service = payload[0].get("Service", {})
node = payload[0].get("Node", {})
address = service.get("Address") or node.get("Address")
port = service.get("Port")

if not address or not port:
    raise SystemExit(f"Consul service {service_name} is missing address/port")

for tag in service.get("Tags") or []:
    match = re.search(r"Host\\(`([^`]+)`\\)", tag)
    if match:
        print(f"https://{match.group(1)}")
        raise SystemExit(0)

consul_host = urllib.parse.urlparse(consul_addr).hostname or ""
parts = consul_host.split(".")
node_name = node.get("Node")
preferred_host = address
if node_name and "." not in node_name and len(parts) > 1:
    preferred_host = f"{node_name}.{'.'.join(parts[1:])}"

print(f"http://{preferred_host}:{port}")
PY
}

consul_service_url() {
  local service_name="$1"
  local path_suffix="${2:-}"
  local root_url

  root_url="$(consul_service_root_url "$service_name")" || return 1
  printf '%s%s\n' "$root_url" "$path_suffix"
}
