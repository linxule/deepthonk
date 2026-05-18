# Security Policy

## Supported versions

DeepThonk is at v0.1. Security fixes land on `main`. There is no LTS branch yet.

## Reporting a vulnerability

Please report security issues privately, not via public GitHub issues:

- Preferred: open a **GitHub Security Advisory** at <https://github.com/linxule/deepthonk/security/advisories/new>.
- Alternative: email the maintainer (see GitHub profile for `linxule`).

Please include:

- A description of the issue and its impact (what an attacker can do).
- Reproduction steps or a proof-of-concept if available.
- Affected component (`deepthonk` CLI, `@deepthonk/core`, `@deepthonk/providers`, `@deepthonk/mcp`) and version/commit.

We aim to acknowledge within 7 days and to land a fix or mitigation within 30 days for actionable reports.

## Scope

In scope:

- Anything that lets an attacker read or write a user's API keys or secrets stored under `~/.config/deepthonk/`.
- Anything that lets a remote attacker (including via DNS rebinding) reach the local MCP HTTP transport.
- Anything that escalates a malicious model response into a host-side compromise (path traversal, code execution, etc.).

Out of scope:

- Cost overruns from the documented `--max-calls`/`--max-usd` overshoot window (see README).
- Cost overruns caused by user-supplied prices in YAML being wrong.
- Provider-side issues that are not specific to DeepThonk's handling.

## Defensive defaults

- HTTP MCP transport binds to `127.0.0.1` only and enables DNS rebinding protection.
- API keys live in a 0600-mode env file outside the repo (`~/.config/deepthonk/env`); they are never logged or written into trace files.
- Prompts and raw model outputs are off by default in trace data (opt-in via `output.includePrompts` / `output.includeRawModelOutputs`).
- Dry-run output redacts common secret-shaped field names.
