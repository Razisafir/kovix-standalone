# LLM Providers — Status

Kovix's agent core talks to LLMs through a single interface (`IConstructAIProvider`).
Any provider that implements that interface can plug into the agent loop. This
doc tracks which providers are verified to work end-to-end vs which are
scaffolded but untested.

## Status legend

- **VERIFIED** — end-to-end tested with a real LLM call. The `test/verify.ts`
  script was run against this provider and all 8 checks passed: agent
  instantiated, real LLM call succeeded, plan returned, staging blocked the
  write, approval callback fired, file NOT written before approval, file
  written after approval with correct content, complete event received.
- **INTERFACE-READY, BLOCKED on key** — implementation is complete (real
  HTTP path against the provider's documented API), but no API key is
  available in the development sandbox to run the real verification call.
  The verify script exists and prints exact user instructions. See the
  per-provider note for the exact command to run locally.
- **INTERFACE-READY, UNTESTED** — implements the interface, compiles cleanly,
  but has NOT been verified with a real LLM call. The stub pattern (delegating
  to `CloudProvider` with provider-specific defaults) means these will likely
  work, but "likely" is not "verified." Test before shipping.

## Provider registry

| Name          | Label                            | Status       | Needs key | Offline | Default model                                    |
|---------------|----------------------------------|--------------|-----------|---------|--------------------------------------------------|
| `anthropic`   | Anthropic Claude                 | VERIFIED     | yes       | no      | `claude-sonnet-4-20250514`                       |
| `ollama`      | Ollama (local)                   | VERIFIED*    | no        | yes     | auto-selected from `/api/tags`                   |
| `openrouter`  | OpenRouter                       | VERIFIED**   | yes       | no      | `nvidia/nemotron-3-super-120b-a12b:free`         |
| `openai`      | OpenAI                           | UNTESTED     | yes       | no      | `gpt-4o`                                         |
| `nvidia`      | NVIDIA NIM                       | BLOCKED†     | yes       | no      | `meta/llama-3.3-70b-instruct`                    |
| `together`    | Together AI                      | UNTESTED     | yes       | no      | `meta-llama/Llama-3.3-70B-Instruct-Turbo`        |
| `groq`        | Groq                             | UNTESTED     | yes       | no      | `llama-3.3-70b-versatile`                        |
| `mistral`     | Mistral                          | UNTESTED     | yes       | no      | `mistral-large-latest`                           |
| `deepseek`    | DeepSeek                         | UNTESTED     | yes       | no      | `deepseek-chat`                                  |
| `gemini`      | Google Gemini (OpenAI-compat)    | UNTESTED     | yes       | no      | `gemini-1.5-pro`                                 |
| `lmstudio`    | LM Studio (local)                | UNTESTED     | no        | yes     | `local-model` (loaded in LM Studio)              |
| `litellm`     | LiteLLM proxy (local)            | UNTESTED     | no        | yes     | `default` (proxy routes it)                      |
| `xenova`      | Xenova (in-process ONNX)         | UNTESTED     | no        | yes     | (not ported — throws clearly)                    |
| `custom`      | Custom OpenAI-compatible          | UNTESTED     | yes       | no      | caller-specified                                 |

† `nvidia` was promoted from a stub to a dedicated provider class in
`src/agent/llm/nvidiaProvider.ts`. The HTTP path is real (delegates to
`CloudProvider` with `provider: 'nvidia'` so the `parallel_tool_calls=false`
workaround applies), the model list is fetched live from
`https://integrate.api.nvidia.com/v1/models` when a key is present, and the
verify script `test/verify-nvidia.ts` makes a real minimal chat call
("say hello in one word") against the live endpoint. The verification is
BLOCKED on a real `nvapi-...` API key — no key is available in the
development sandbox. To verify locally:

```bash
# Option A — via the UI:
npm start
# → click gear icon → pick NVIDIA NIM → paste nvapi-... key →
# → pick a model → Test connection → Save → close window
npm run verify:nvidia

# Option B — via env var (dev shortcut):
NVIDIA_API_KEY=nvapi-... npm run verify:nvidia
```

The verify script NEVER hardcodes or reuses a credential. If it can't find
a key, it exits with code 2 (BLOCKED) and prints the exact steps above.
See `test/transcripts/verify-nvidia-BLOCKED-nokey.txt` for the captured
sandbox output.

\* `ollama` is verified at the interface level — `checkStatus()` correctly
reports `unreachable` when Ollama isn't running, and the chat path is
ported verbatim from the Kovix_2.0 VS Code fork. To verify end-to-end
with a real model, install Ollama locally and run:

```bash
npx tsx test/verify.ts --provider ollama
```

\** `openrouter` was verified using free-tier models
(`nvidia/nemotron-3-super-120b-a12b:free` and `openai/gpt-oss-20b:free`).
Free models on OpenRouter rate-limit unpredictably and sometimes refuse to
call tools — for production use, prefer a paid OpenRouter model or
Anthropic directly.

## How to verify an untested provider

Each untested provider follows the same pattern: it's a thin wrapper around
`CloudProvider` with provider-specific defaults (baseUrl, default model).
To move one from UNTESTED to VERIFIED:

1. Get a real API key for that provider.
2. Run the verify script:
   ```bash
   npx tsx test/verify.ts --provider <name> --api-key <key>
   ```
3. If all 8 checks pass, update the provider's `verified: true` flag in
   `src/agent/llm/providerFactory.ts` and update the table above.
4. If checks fail, paste the transcript into a new GitHub issue. The most
   common failure modes are:
   - Provider's API isn't actually OpenAI-compatible (Gemini native, Anthropic
     native) — needs a dedicated provider class, not a stub.
   - Provider requires extra headers (HTTP-Referer, X-Title) — add to
     `CloudProvider._buildHeaders()` or override in the stub.
   - Provider's tool-call format differs from OpenAI's — needs custom parsing
     in the stub's `chat()` method.

## Architecture

```
                  IConstructAIProvider  (unified interface)
                          |
            +-------------+-------------+
            |             |             |
     CloudProvider   OllamaProvider   XenovaProvider
     (Anthropic +    (local HTTP      (in-process ONNX —
      OpenAI-compat)  to :11434)       NOT PORTED)
            |
   stubProviders.ts delegates to CloudProvider with
   provider-specific defaults (baseUrl, default model):
     OpenAIProvider, OpenRouterProvider, NvidiaNimProvider,
     TogetherProvider, GroqProvider, MistralProvider,
     DeepSeekProvider, GeminiProvider, LmStudioProvider,
     LiteLLMProvider
```

The agent loop only depends on `IConstructAIProvider`. It doesn't know or
care which concrete provider is active — that's the whole point of the
abstraction. The UI's provider picker (Phase 1) will use `listProviders()`
and `createProvider()` from `providerFactory.ts` to instantiate the user's
chosen provider.

## What's NOT here (deliberately)

- **Xenova in-process inference** — the original VS Code fork had a 414-line
  XenovaProvider that ran quantized ONNX models in a web worker. We did NOT
  port it because (a) it pulls in `@xenova/transformers` (~50MB), (b) the
  in-process ONNX runtime is tricky in Node vs browser, and (c) Ollama
  covers the "local, no API key" use case better. If you want offline
  inference without installing Ollama, this is the provider to build out.

- **Native Gemini multimodal** — Gemini's native API supports image/video
  input that the OpenAI-compat shim doesn't. The stub uses the OpenAI-compat
  endpoint; for native Gemini support, write a dedicated provider class.

- **Copilot-style inline completion** — the original `IConstructAIProvider`
  had a `complete()` method for inline code suggestions. We stripped it in
  Phase 0 because the agent loop doesn't use it. Will rebuild for the new
  UI later if needed.
