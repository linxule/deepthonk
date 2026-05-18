# Customization

DeepThonk exposes the OpenDeepThink loop as a composable primitive. Every algorithm dimension — population shape, temperatures, regularization, prompt templates — is reachable inline through MCP arguments and CLI flags, not just through YAML files. This document is the contract for that surface: what you can change, where you can change it, and what the rules are.

See `docs/algorithm.md` for the loop itself, `README.md` for the product context, and the `Acknowledgments` section in the README for the paper and Python reference DeepThonk reimplements.

## What you can customize

DeepThonk exposes the same core run config through CLI, MCP, and YAML, with one prompt-specific asymmetry noted below.

| Customization | CLI surface | MCP surface | YAML config field |
|---|---|---|---|
| Profile params | `--n`, `--k`, `--t`, `--m` | `n`, `k`, `t`, `m` | `algorithm.n`, `algorithm.k`, `algorithm.t`, `algorithm.m` |
| Algorithm constants | `--lambda`, `--sample-temperature`, `--mutate-temperature`, `--judge-temperature` | `lambda`, `sample_temperature`, `mutate_temperature`, `judge_temperature` | `algorithm.lambda`, `algorithm.sample_temperature`, `algorithm.mutate_temperature`, `algorithm.judge_temperature` |
| Prompt style | `--prompt-style` | `prompt_style` | `prompt_style` |
| Per-phase prompts | `--prompts <yaml-path>`, `--prompts-json <json>` | `prompts` | `prompts` |
| Concurrency | `--max-concurrency` | `concurrency.generate`, `concurrency.judge`, `concurrency.mutate` | `concurrency.generate`, `concurrency.judge`, `concurrency.mutate` |

The built-in profiles are `quick`, `balanced`, and `paper`.
The `paper` profile defaults to `paper-programming` prompt style.
Other profiles default to `general`.
Explicit `--prompt-style`, MCP `prompt_style`, or YAML `prompt_style` overrides that default.

CLI flags override YAML where both are present.
MCP inline arguments override YAML where both are present.
Prompt overrides merge by phase and field.
For example, `prompts.compare.system` can replace only the compare system template while leaving the built-in compare user template intact.

## Algorithm-shape overrides

`n` is the population size.
DeepThonk generates `n` initial candidates before the first comparison round.
Larger `n` increases breadth and also increases comparison cost.

`k` is comparisons per candidate per generation.
Each generation schedules randomized pairwise comparisons so each candidate receives about `k` comparisons.
Larger `k` gives Bradley-Terry more evidence and costs more judge calls.

`t` is the number of mutation generations.
`t=0` means generate once, compare, and finalize the ranked winner without mutation rounds.
Larger `t` gives the loop more chances to preserve elites, mutate candidates, and discard weak candidates.

`m` is the number of comparisons per candidate in the **final dense ranking round** — analogous to `k` but applied only to the last ranking pass after all `t` mutation generations.
The number of mutations per generation is not `m`; it is `n - ceil(n/4)` (survivors after the bottom quartile is discarded and the top quartile is copied as elites).
For profiles where `n` is not divisible by four, DeepThonk avoids creating extra mutants that would be immediately truncated.
A larger `m` produces tighter final ranking at the cost of `(n * m) / 2` extra judge calls in the final round.

Overrides merge with profile defaults.
A `paper` profile with `n: 12` keeps the paper defaults for `k`, `t`, and `m`, but uses population size `12`.
The same merge rule applies to constants.
For example, setting `judge_temperature: 0.2` leaves `lambda`, `sample_temperature`, and `mutate_temperature` at their profile or YAML defaults.

`lambda` is Bradley-Terry L2 regularization.
The built-in default is `0.01`.
Raising it damps score separation when comparison data is sparse or noisy.

`sample_temperature` is used for initial candidate generation.
Higher values usually increase diversity in the first population.

`mutate_temperature` is used for critique-guided mutation.
Higher values usually make mutations less conservative.

`judge_temperature` is used for pairwise judging.
The built-in default is `0` because judge stability matters more than judge creativity.

Concurrency does not change the algorithm result definition.
It changes how many provider calls can run at once in each phase.
CLI `--max-concurrency` applies one cap to generate, judge, and mutate phases.
MCP and YAML can set per-phase caps.

Default concurrency:

| Phase | Default |
|---|---|
| `generate` | `n` |
| `judge` | `max(1, (n * max(k, m)) / 2)` |
| `mutate` | `n - floor(n / 4)` |

## MCP Sampling provider

Use `provider: "sampling"` only inside an MCP host that can answer MCP Sampling `createMessage` requests. It lets DeepThonk use the host's model picker instead of a configured API key.
Standalone CLI runs cannot use sampling; use `deepseek`, `openrouter`, or `openai-compatible` from the CLI.

Sampling model fields are hints, not enforcement. `generator_model`, `mutator_model`, `judge_model`, and `finalizer_model` become per-role model hints, and MCP `sampling_model_hints` adds extra host-facing hints. A sampling-capable client may ignore any hint and choose another model.

Before a sampling run starts, the MCP server checks `server.getClientCapabilities()`. If the connected client does not advertise `sampling`, `deepthonk.run` and `deepthonk.start` fail with `provider.sampling_capability_missing` before claiming the run directory or making model calls.

Sampling adds a host round trip for every model call, so latency depends on both DeepThonk's phase concurrency and the host's sampling queue. DeepThonk caps sampling concurrency at `min(n, 4)` even when higher per-phase concurrency is configured.

MCP Sampling responses do not provide standardized token usage. DeepThonk records `inputTokens` and `outputTokens` as unavailable for sampling calls. `maxCalls` still works; token and USD caps can warn or become unenforceable unless the host/provider supplies usage through a direct provider mode.

## Prompt template variables

Prompt overrides are templates.
Each phase has a fixed variable set.

| Phase | Variables | Description |
|---|---|---|
| `generate` | `{task}` | Task text supplied by CLI, MCP, or task file. |
| `generate` | `{rubric}` | Rubric text, or the phase default rubric when none is supplied. |
| `compare` | `{task}` | Original task text. |
| `compare` | `{rubric}` | Comparison rubric, or the phase default rubric when none is supplied. |
| `compare` | `{candidateA}` | Candidate content presented as solution A. |
| `compare` | `{candidateB}` | Candidate content presented as solution B. |
| `mutate` | `{task}` | Original task text. |
| `mutate` | `{rubric}` | Mutation rubric, or the phase default rubric when none is supplied. |
| `mutate` | `{candidate}` | Current candidate being improved. |
| `mutate` | `{critique}` | Aggregated critique from pairwise comparison feedback. |
| `finalize` | `{task}` | Original task text. |
| `finalize` | `{rubric}` | Finalization rubric, or the phase default rubric when none is supplied. |
| `finalize` | `{candidate}` | Winning candidate selected by final ranking. |

## Substitution rules

`{name}` substitutes the variable named `name`.
`{{` renders a literal `{`.
`}}` renders a literal `}`.

Unknown variables throw a `ConfigError` at run-start.
This is fail-fast behavior, not silent passthrough.
DeepThonk validates only templates that you override.
Built-in templates are already valid.

Partial overrides are allowed.
If an override supplies only `system`, the built-in `user` template remains active for that phase.
If an override supplies only `user`, the built-in `system` template remains active for that phase.

When overriding `compare`, the template must instruct the model to return strict JSON in this shape:

```json
{
  "feedback_a": "...",
  "feedback_b": "...",
  "winner": "A|B|tie"
}
```

DeepThonk has a robust JSON extractor, but that extractor is a recovery path, not a substitute for the prompt contract.
A compare template that does not ask for JSON degrades comparison quality and increases the chance of invalid or ambiguous judge output.

## Three worked examples

Legal drafting uses a non-code task and inline MCP args.
This path is usually better for agents because no temporary prompt file is needed.

```json
{
  "task": "Draft a concise non-solicitation clause for a senior sales employee.",
  "rubric": "Prefer the clause that better protects the employer while remaining enforceable under California law.",
  "profile": "balanced",
  "provider": "deepseek",
  "generator_model": "deepseek-v4-flash",
  "mutator_model": "deepseek-v4-flash",
  "judge_model": "deepseek-v4-pro",
  "prompt_style": "general",
  "prompts": {
    "generate": {
      "system": "You are an experienced employment-law attorney. Draft practical contract language. Do not include hidden chain-of-thought. Return the clause and concise drafting notes only."
    }
  }
}
```

Cheap exploration keeps the `paper` profile orientation but cuts budget with CLI flags.
This keeps paper defaults not explicitly overridden, including `k=4` and `m=10`.

```bash
deepthonk run \
  --task examples/tasks/toy-math.txt \
  --provider fake \
  --profile paper \
  --n 8 \
  --t 1 \
  --out runs/paper-cheap
```

Tuning judge strictness can override only `compare.system`.
The built-in compare user template still supplies the task, rubric, candidates, and strict JSON output shape.

```json
{
  "task": "Choose the best migration plan for this API change.",
  "rubric": "Prefer plans that reduce production risk and preserve backward compatibility.",
  "profile": "balanced",
  "provider": "deepseek",
  "generator_model": "deepseek-v4-flash",
  "mutator_model": "deepseek-v4-flash",
  "judge_model": "deepseek-v4-pro",
  "prompts": {
    "compare": {
      "system": "You are a strict engineering reviewer. Penalize vague rollback plans, unbounded migrations, missing observability, and claims that are not supported by the candidate text. Return no hidden chain-of-thought."
    }
  }
}
```

## CLI prompt inputs

CLI accepts prompt overrides either as reusable YAML via `--prompts <yaml-path>` or inline JSON via `--prompts-json <json>`.
The YAML or JSON object maps phase names to `{ system, user }` templates:

```yaml
generate:
  system: |
    You are an expert solver for the target domain.
    Return the final artifact directly.
compare:
  system: |
    You are a stricter than usual judge.
```

Use CLI prompt files when you would rather author, review, and reuse prompts in YAML.
Use `--prompts-json` or MCP inline `prompts` when an agent is constructing a one-off run and should not create a prompt file.
MCP inline prompt args have the same phase names and `{ system, user }` fields as YAML.

YAML config can also contain `prompts`.
CLI `--prompts` merges over config `prompts`, and `--prompts-json` merges over both.
MCP inline `prompts` merges over config `prompts`.

## Named profiles

Inline overrides are the right surface for one-off runs.
Named profiles are the right surface for a customization you want to reuse.
A named profile is a standalone YAML bundle that lives in `~/.config/deepthonk/profiles/<name>.yaml`.
Override the directory with `DEEPTHONK_PROFILES_DIR=/path/to/profiles`.

Load a named profile with `--profile-name <name>` on the CLI or `profile_name: "<name>"` in MCP.
A named profile replaces the main config file for that run — `--profile-name` and `--config` cannot be used together.
CLI flags and MCP inline arguments still override fields inside the named profile.

A named profile must declare enough to fully describe a run:

| Field | Required | Notes |
|---|---|---|
| `profile` or `algorithm` | required | Either a built-in profile name as the algorithm floor (`quick`, `balanced`, `paper`) or an explicit `algorithm` block. |
| `prompt_style` | required | `general` or `paper-programming`. |
| `provider` | required | Provider label. |
| `models.generator` | required | Model used for initial generation. |
| `models.mutator` | required | Model used for mutation. |
| `models.judge` | required | Model used for pairwise judging. |
| `models.finalizer` | optional | Model used to polish the winner. Defaults to the generator. |
| `prompts` | optional | Per-phase template overrides. Same shape as `--prompts` YAML. |
| `providers` | optional | Per-role provider routing for mixed-provider runs. |
| `budget` | optional | Cost and call caps. |
| `concurrency` | optional | Per-phase concurrency caps. |
| `base_url`, `api_key_env` | optional | Required only when the provider needs them. |

Named profiles must never contain a raw `api_key` value.
Use `api_key_env` to point at an environment variable name; DeepThonk will read that env var at run time.
The CLI rejects profiles that contain a top-level or per-role `api_key` field.

Example profile (also shipped at `examples/profiles/legal-drafting.yaml`):

```yaml
profile: balanced
prompt_style: general

provider: deepseek
api_key_env: DEEPSEEK_API_KEY
models:
  generator: deepseek-v4-flash
  mutator: deepseek-v4-flash
  judge: deepseek-v4-pro

algorithm:
  judge_temperature: 0.1

prompts:
  generate:
    system: |
      You are an experienced employment-law attorney. Draft practical contract
      language. Do not include hidden chain-of-thought. Return the clause only.

budget:
  max_calls: 50
```

Run it:

```bash
deepthonk run --profile-name legal-drafting --task "Draft a non-solicitation clause."
```

Or call it through MCP:

```json
{
  "profile_name": "legal-drafting",
  "task": "Draft a non-solicitation clause."
}
```

CLI flags still win for the run.
For example, `deepthonk run --profile-name legal-drafting --judge-temperature 0.3 ...` raises the judge temperature only for that call.

## Managing named profiles

Named profiles can be managed without hand-editing the registry directory.
The CLI and MCP surfaces expose the same registry operations:

| Operation | CLI | MCP |
|---|---|---|
| List profiles | `deepthonk profile list` or `deepthonk profile list --json` | `deepthonk.profile_list` with `{}` |
| Show one profile | `deepthonk profile show legal-drafting` | `deepthonk.profile_show` with `{ "name": "legal-drafting" }` |
| Save from YAML | `deepthonk profile save legal-drafting --from-config ./legal.yaml` | `deepthonk.profile_save` with the profile bundle plus `{ "name": "legal-drafting" }` |
| Save from inline fields | `deepthonk profile save quick-fake --profile quick --prompt-style general --provider fake --generator-model fake-model --mutator-model fake-model --judge-model fake-model` | `deepthonk.profile_save` with `{ "name": "quick-fake", "profile": "quick", "prompt_style": "general", "provider": "fake", "models": { "generator": "fake-model", "mutator": "fake-model", "judge": "fake-model" } }` |
| Overwrite | Add `--force` | Add `"force": true` |
| Delete | `deepthonk profile delete legal-drafting --yes` | `deepthonk.profile_delete` with `{ "name": "legal-drafting" }` |

`profile show` and `deepthonk.profile_show` redact secret-shaped values such as `token`, `secret`, `password`, `authorization`, and `api_key`.
They keep `api_key_env` visible because it is metadata naming where the runtime secret lives.
`profile save` and `deepthonk.profile_save` reject raw `api_key` fields; use `api_key_env` instead.
Creating a profile uses create-or-fail writes, and overwriting uses a temporary file plus rename.

## What stays YAML-only

Per-role provider routing stays YAML-only through `providers.generator`, `providers.mutator`, `providers.judge`, and `providers.finalizer`.
It belongs in YAML because it can mix provider labels, base URLs, API-key environment names, JSON-mode support, and model IDs across roles.

Per-model pricing stays YAML-only through `budget.prices`.
It belongs in YAML because pricing is provider-specific reference data that should be reviewed and updated separately from ad hoc run arguments.
