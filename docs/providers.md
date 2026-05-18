# Providers

All providers implement the `ModelDriver` interface from `@deepthonk/core`.

## Setup Command

`deepthonk setup` writes a reusable config at `~/.config/deepthonk/config.yaml` by default:

```bash
deepthonk setup --provider deepseek --fast-model deepseek-v4-flash --judge-model deepseek-v4-pro
```

The command configures the common two-role choice directly: a fast model for generation/mutation, and a stronger judge model. Use `--generator-model` and `--mutator-model` when those should differ. API keys are referenced through `api_key_env`; `--api-key` writes a separate local DeepThonk env file instead of putting the secret in YAML.

## Fake

The fake provider is deterministic and intended for tests, demos, and trace inspection.
It makes no network calls and requires no API key.

```bash
rm -rf runs/test-quick
deepthonk run --provider fake --profile quick --task examples/tasks/toy-math.txt --out runs/test-quick
deepthonk inspect runs/test-quick
```

## OpenAI-Compatible

The generic driver sends chat completions requests to:

```txt
{base_url}/chat/completions
```

It reads the API key from the configured environment variable and does not write that value into traces.
Provider HTTP errors are sanitized by default; normal CLI/MCP errors do not include raw upstream response bodies. The driver retries retryable 429/5xx failures, respects `Retry-After` when present, and supports `requestTimeoutMs` from CLI flags or YAML `retry`.

You can use any OpenAI-compatible provider by setting `provider`, `base_url`, `api_key_env`, and the role-specific model names:

```yaml
provider: my-provider
base_url: https://provider.example.com/v1
api_key_env: MY_PROVIDER_API_KEY
models:
  generator: cheap-or-fast-model
  mutator: cheap-or-fast-model
  judge: strong-judge-model
retry:
  requestTimeoutMs: 60000
```

Unknown provider names are treated as OpenAI-compatible when a `base_url` is provided. This keeps traces labeled with the provider identity you chose instead of forcing every custom endpoint to appear as `openai-compatible`.

## DeepSeek

DeepSeek is a convenience profile over the OpenAI-compatible driver:

```yaml
provider: deepseek
base_url: https://api.deepseek.com/v1
api_key_env: DEEPSEEK_API_KEY
models:
  generator: deepseek-v4-flash
  mutator: deepseek-v4-flash
  judge: deepseek-v4-pro
```

DeepThonk includes default USD pricing for `deepseek-v4-flash` and `deepseek-v4-pro` from the official DeepSeek pricing page, checked 2026-05-18:

```yaml
budget:
  prices:
    - provider: deepseek
      model: deepseek-v4-flash
      inputCacheHitUsdPerMillion: 0.0028
      inputCacheMissUsdPerMillion: 0.14
      outputUsdPerMillion: 0.28
    - provider: deepseek
      model: deepseek-v4-pro
      inputCacheHitUsdPerMillion: 0.003625
      inputCacheMissUsdPerMillion: 0.435
      outputUsdPerMillion: 0.87
```

Source: https://api-docs.deepseek.com/quick_start/pricing/

The driver records DeepSeek `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` when returned, so `usage.usd` uses cache-aware input pricing. The V4-Pro numbers are discounted rates that DeepSeek says run until 2026-05-31 15:59 UTC. Edit model names and prices in config as the provider surface changes.

## OpenRouter

OpenRouter is available as a preset over the OpenAI-compatible driver:

```yaml
provider: openrouter
api_key_env: OPENROUTER_API_KEY
models:
  generator: openrouter/auto
  mutator: openrouter/auto
  judge: openrouter/auto
```

OpenRouter model IDs are intentionally config, not code. Prefer setting explicit model IDs for generator, mutator, and especially judge when reproducibility matters.

Reference: https://openrouter.ai/docs/quickstart

## Mixed Providers

Use `providers` in YAML when different stages should use different provider accounts or endpoints. Role overrides can make paid calls even if another top-level provider is configured:

```yaml
provider: openrouter
api_key_env: OPENROUTER_API_KEY
models:
  generator: openrouter/auto
  mutator: openrouter/auto
  judge: openrouter/auto
providers:
  judge:
    provider: deepseek
    api_key_env: DEEPSEEK_API_KEY
    model: deepseek-v4-pro
```

The top-level provider remains the default route. Any role listed under `providers` overrides only that stage: `generator`, `mutator`, `judge`, or `finalizer`.

When using `maxUsd` with non-default providers, add pricing for the provider/model IDs that are actually returned by each routed provider:

```yaml
budget:
  maxUsd: 1.50
  prices:
    - provider: openrouter
      model: openrouter/auto
      inputUsdPerMillion: 1
      outputUsdPerMillion: 2
    - provider: deepseek
      model: deepseek-v4-pro
      inputUsdPerMillion: 2
      outputUsdPerMillion: 8
```
