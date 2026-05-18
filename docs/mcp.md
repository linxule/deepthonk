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

The tools are implemented over the shared core and provider interfaces. Use `start/status/result/cancel` for long runs so agents can poll trace-backed state without blocking the MCP call. `run` is still available as a blocking wrapper.

`resume` is conservative: it reports completed, running, cancel-requested, cancelled, failed, budget-stopped, missing, or interrupted trace state and marks unsafe traces with `safe_to_continue: false`. It never reuses partial in-flight model outputs and does not replay runs yet.

MCP Sampling is intentionally deferred. It is not advertised as a provider option until a host-negotiated Sampling driver is implemented.

Tool handlers return `structuredContent` with a matching broad output schema, plus a text rendering for clients that display only content blocks. Tool failures are structured as `isError: true` with stable `code`, `message`, `retryable`, `fix`, and optional `run_dir` fields.

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

The blocking run response includes `summary_resource` and `trace_resource`; read those resources instead of asking the tool to inline full traces. The async start response includes job status/result resource URIs with the run directory embedded as a query parameter.

## Resources

- `deepthonk://runs`
- `deepthonk://runs/{run_id}/summary`
- `deepthonk://runs/{run_id}/candidates`
- `deepthonk://runs/{run_id}/comparisons`
- `deepthonk://runs/{run_id}/scores`
- `deepthonk://runs/{run_id}/trace`
- `deepthonk://runs/{run_id}/final`
- `deepthonk://runs/{run_id}/winner`
- `deepthonk://runs/{run_id}/status`
- `deepthonk://jobs/{job_id}/status?run_dir=...`
- `deepthonk://jobs/{job_id}/result?run_dir=...`

Resources are keyed by the recorded `run_id`. For MCP runs that write to custom absolute directories, the server records a local run index so the advertised resource URI can still resolve.

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

The endpoint is `http://127.0.0.1:3333/mcp`.
