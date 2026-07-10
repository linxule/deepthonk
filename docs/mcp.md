# MCP

DeepThonk uses the stable official TypeScript SDK package:

```txt
@modelcontextprotocol/sdk
```

The newer split `@modelcontextprotocol/server` package was alpha at implementation time, so this project uses the stable v1 SDK.

## Tools

- `deepthonk.plan`
- `deepthonk.start`
- `deepthonk.status`
- `deepthonk.result`
- `deepthonk.cancel`
- `deepthonk.run`
- `deepthonk.rank`
- `deepthonk.mutate`
- `deepthonk.resume`
- `deepthonk.export`
- `deepthonk.profile_list`
- `deepthonk.profile_show`
- `deepthonk.profile_save`
- `deepthonk.profile_delete`

The tools are implemented over the shared core and provider interfaces. Use `start/status/result/cancel` for long runs so agents can poll trace-backed state without blocking the MCP call. `run` is still available as a blocking wrapper.

`resume` is conservative by default: it reports completed, running, cancel-requested, cancelled, failed, budget-stopped, missing, resumable, or interrupted trace state and marks unsafe traces with `safe_to_continue: false`. With `continue: true`, it validates the stored config/version/provider, prunes to the last completed phase boundary, and replays from there. It never reuses partial in-flight model outputs.

MCP Sampling is available over stdio as `provider: "sampling"` for `deepthonk.run` and `deepthonk.start` when the connected client advertises the sampling capability. If it does not, the tool fails before claiming a run directory with `provider.sampling_capability_missing`. The v0.1 patch line rejects Sampling over Streamable HTTP and rejects mixed Sampling/direct role routes; choose a direct provider there.

Successful tool handlers return `structuredContent` with a matching broad output schema plus a text rendering. Failures return `isError: true` and JSON text with stable `code`, `message`, `retryable`, `fix`, and optional `run_dir` fields, but intentionally omit `structuredContent`: official SDK 1.29 clients otherwise validate an error against the success schema and mask the real failure.

## Host Configuration

Launch stdio from an installed binary:

```json
{
  "command": "deepthonk",
  "args": ["serve-mcp", "--transport", "stdio"],
  "env": {
    "DEEPSEEK_API_KEY": "..."
  }
}
```

MCP tools do not automatically read CLI setup unless a tool call includes `config_path`. Use provider fields inline or pass a config path:

```json
{
  "task": "Solve the task.",
  "profile": "quick",
  "config_path": "/Users/me/.config/deepthonk/config.yaml"
}
```

For a safe local smoke test, call `deepthonk.start` with:

```json
{
  "task": "Return a concise answer to a toy task.",
  "profile": "quick",
  "provider": "fake"
}
```

Then poll:

```json
{ "run_dir": "the run_dir returned by start" }
```

with `deepthonk.status`, and call `deepthonk.result` when status becomes `completed`.

For OpenRouter:

```json
{
  "task": "Solve the task.",
  "profile": "quick",
  "provider": "openrouter",
  "api_key_env": "OPENROUTER_API_KEY",
  "generator_model": "openrouter/auto",
  "mutator_model": "openrouter/auto",
  "judge_model": "openrouter/auto"
}
```

The blocking run response includes `summary_resource` and `trace_resource`; read those resources instead of asking the tool to inline full traces. The async start response includes job status/result resource URIs with the run directory embedded as a query parameter, plus `artifact_resources` for job-scoped config, candidates, comparisons, scores, usage, trace, status, final, winner, and a `population_template` URI.

## Resources

- `deepthonk://runs`
- `deepthonk://runs/{run_id}/summary`
- `deepthonk://runs/{run_id}/config`
- `deepthonk://runs/{run_id}/candidates`
- `deepthonk://runs/{run_id}/comparisons`
- `deepthonk://runs/{run_id}/scores`
- `deepthonk://runs/{run_id}/usage`
- `deepthonk://runs/{run_id}/trace`
- `deepthonk://runs/{run_id}/population/{generation}`
- `deepthonk://runs/{run_id}/final`
- `deepthonk://runs/{run_id}/winner`
- `deepthonk://runs/{run_id}/status`
- `deepthonk://jobs/{job_id}/status?run_dir=...`
- `deepthonk://jobs/{job_id}/result?run_dir=...`
- `deepthonk://jobs/{job_id}/{config|candidates|comparisons|scores|usage|trace|final|winner}?run_dir=...`
- `deepthonk://jobs/{job_id}/population/{generation}?run_dir=...`
- `deepthonk://runs/{run_id}/{resource}/page/{cursor}` and job equivalents for opaque bounded paging

Resources are keyed by the recorded `run_id`. For MCP runs that write to custom absolute directories, the server records a local run index so the advertised resource URI can still resolve.
Job-scoped resources require the exact `job_id` and `run_dir` pair returned by `deepthonk.start`, so agents can inspect files as soon as they are written without turning the query parameter into an arbitrary filesystem read. Whole reads are capped at 1 MiB; record pages are capped at 1,000 rows and 1 MiB, while singleton JSON/text artifacts use bounded base64 byte pages.

## Prompts

- `deepthonk/generate`
- `deepthonk/compare`
- `deepthonk/mutate`
- `deepthonk/finalize`

## Transports

`stdio` is the default for local MCP hosts. Streamable HTTP is available on localhost:

```bash
deepthonk serve-mcp --transport http --port 3333
```

The endpoint is `http://127.0.0.1:3333/mcp`. It maintains one MCP server/transport per cryptographic session across `POST`, `GET`, and `DELETE`; sessions are capped at 64 and expire after 30 idle minutes when no request is in flight.

## Security defaults

The HTTP transport binds to `127.0.0.1` only and runs with the MCP SDK's DNS rebinding protection enabled, with `Host` validated against `127.0.0.1:<port>` and `localhost:<port>`. Before reading request bodies, it also rejects non-`application/json` POSTs, non-loopback `Origin` headers, and `Sec-Fetch-Site: cross-site`. Loopback bind alone does not protect against browser-pivoted attackers (see CVE-2025-66414 / GHSA-w48q-cv73-mx4w), so do not remove the rebinding guard when adding new transport features. The HTTP transport has no bearer auth — treat it as trusted-local-host-only and prefer `stdio` for MCP host integration.

API keys are read from `process.env` and never logged or written into trace files. Background admission is FIFO with 2 active and 32 queued jobs; overflow is retryable. The runner wraps driver construction, status writes, resource/index recording, and verified lock release so transient I/O errors cannot surface as unhandled rejections.
