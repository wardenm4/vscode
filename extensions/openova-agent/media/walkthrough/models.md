# Bring any model

Openova talks to **any provider** — nothing is locked in.

- **Hosted**: Anthropic (Claude), OpenAI, Google Gemini, Groq, DeepSeek, xAI (Grok), Mistral, Together, Fireworks, OpenRouter, OpenCode Zen
- **Local & private**: LM Studio, Ollama, llama.cpp, vLLM — your code never leaves the machine

Open the agent sidebar, click the model name in the composer, pick a provider, and paste an API key (stored in the OS keychain) — or point at a local server and pick from the models it reports.

Power moves:

- `openova.fallbackModels` — a fallback chain that kicks in automatically when your primary model is rate-limited or down
- `openova.modelPlan` / `modelTitle` / `modelCompletion` — cheap fast models for plans, chat titles, and tab ghost text
- `openova.budgetUSD` — a soft spend budget with a live cost meter
