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

## What stays YAML-only

Per-role provider routing stays YAML-only through `providers.generator`, `providers.mutator`, `providers.judge`, and `providers.finalizer`.
It belongs in YAML because it can mix provider labels, base URLs, API-key environment names, JSON-mode support, and model IDs across roles.

Per-model pricing stays YAML-only through `budget.prices`.
It belongs in YAML because pricing is provider-specific reference data that should be reviewed and updated separately from ad hoc run arguments.
