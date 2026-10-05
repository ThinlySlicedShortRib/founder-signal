# Podcast experiment: cost-effective ways to turn an article into audio

Research done on 2026-10-04. Prices were checked on official pages that day (sources inline). Where a number is my own calculation or a third-party estimate, it says so.

**Assumptions**
- A 10-minute episode is about 1,500 spoken words, or about 9,000 characters.
- A script call is about 5.5k input tokens (the article plus the prompt) and 2.5k output tokens.
- Our real episodes so far are shorter: about 4 minutes, roughly 600 words or 3,500 characters, from about 4.7k input and 1.1k output tokens.

## 1. The script step

| Option | What it sounds like | Risk | Verdict |
|---|---|---|---|
| Plain narration of the article (no model) | An audiobook of the piece. Long: a 3,000-word piece is about 18 minutes. | None. It is the author's words. | Kept as the **fallback** (`reading`): the opening, read verbatim. |
| Narrated summary (one voice) | 4–7 minutes, a "friend summarising it" | A model can add facts, so it needs checks. | Supported (`PODCAST_FORMAT=narration`). |
| Two-host conversation (NotebookLM-style) | 4–7 minutes. The most engaging to listen to. | The highest risk of invented filler. | **Default.** The prompt forbids outside facts, and the deterministic checks enforce it. |

**Claude price per script** (https://claude.com/pricing; anthropic.com/pricing now redirects there):

| Model | $/MTok in / out | 10-min episode | Our measured 4-min episodes |
|---|---|---|---|
| Haiku 4.5 | $1 / $5 | ≈ $0.018 | ≈ $0.010 |
| **Sonnet 5.5** (used) | $2 / $10 | ≈ $0.036 | **≈ $0.021** |
| Opus 5.5 | $4 / $20 | ≈ $0.072 | — |

- The Batch API is 50% off, which suits a background job.
- Episodes are generated once per article version and shared, so Sonnet's extra ~1¢ buys a noticeably better script.
- **Bedrock note:** no Claude model runs in-Region in ap-southeast-2. Haiku 4.5 is available through the AU geo profile, and Sonnet 5.5 only through the global profile ([model/Region table](https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html)). Both cut against this project's "selected Region only" constraint, so the script stays on the Anthropic API, as the letter writer already does.

## 2. The voice step: local open-weight models on Apple Silicon

| Model | Licence (code / weights) | Size | Two speakers? | On a Mac | Notes |
|---|---|---|---|---|---|
| **Kokoro-82M v1.0** | Apache-2.0 / Apache-2.0 | 82M | 54 preset voices; alternate them per line | **Measured here:** 8.7× real-time on M-series CPU via `kokoro-onnx` (229 s of audio in 26 s, idle machine). Third-party: 12–22× with mlx-audio. | Top open-weight model on TTS Arena (#32 overall, a third-party summary: https://www.offlinetts.com/blog/tts-arena-leaderboard-2026/). [HF](https://huggingface.co/hexgrad/Kokoro-82M) |
| Piper | GPL-3.0 / per-voice | small | one voice per model | fast CPU | GPL code; flatter prosody. [repo](https://github.com/OHF-Voice/piper1-gpl) |
| Sesame CSM-1B | Apache-2.0 (gated) | ~1–2B | yes (`[0]`/`[1]`) | in mlx-audio | Gated download; heavier. [HF](https://huggingface.co/sesame/csm-1b) |
| Dia 1.6B / Dia2 | Apache-2.0 | 1.6B / 1–2B | yes (`[S1]`/`[S2]`) | CUDA-oriented; Dia2 needs CUDA 12.8 | The best "real dialogue" open models, but not Mac-friendly. [dia](https://github.com/nari-labs/dia), [dia2](https://github.com/nari-labs/dia2) |
| Orpheus 3B | Apache code; Llama-based weights (licence unverified) | 3B | 8 voices | vLLM / llama.cpp | Heavy for a laptop. [repo](https://github.com/canopyai/Orpheus-TTS) |
| F5-TTS v1 | MIT / **CC-BY-NC** | — | style/speaker | runs on Apple Silicon | Non-commercial weights. [repo](https://github.com/SWivid/F5-TTS) |
| Chatterbox (500M / Turbo 350M / Nano 110M) | MIT / MIT | 110–500M | cloning only, no dialogue | `mps` supported | Output is watermarked. [repo](https://github.com/resemble-ai/chatterbox) |
| Kyutai TTS (DSM) | MIT / **CC-BY 4.0** | — | not documented | native MLX script | [repo](https://github.com/kyutai-labs/delayed-streams-modeling) |
| Higgs Audio v3 | **research / non-commercial** | 4B | conversational | GPU | [repo](https://github.com/boson-ai/higgs-audio) |
| VibeVoice | MIT | 1.5B / 0.5B | up to 4 speakers | in mlx-audio | Microsoft **removed the TTS code** over responsible-AI concerns. [repo](https://github.com/microsoft/VibeVoice) |
| Kitten TTS | Apache code / community licence | 15–80M | 47 voices | real-time on CPU | Restrictive model licence. [repo](https://github.com/KittenML/KittenTTS) |
| NeuTTS, IndexTTS-2.5 | Apache / bilibili (restricted) | 0.1–0.8B | cloning | GGUF / no MPS | — |

**Pick:** Kokoro-82M through [`kokoro-onnx`](https://pypi.org/project/kokoro-onnx/) 0.6.1.
- **Licence:** Apache-2.0 weights and MIT code.
- **Install:** espeak-ng is bundled through `espeakng-loader` wheels, so nothing goes system-wide.
- **Platforms:** the same code runs on Linux, so the AWS container option below reuses it unchanged.
- **Size:** 325 MB fp32 model plus 28 MB of voices. Quantised builds are 169 MB (fp16) and 88 MB (int8).
- **Two hosts:** `af_heart` + `am_michael`, alternating per line. That is not true joint-dialogue modelling (Dia/CSM), but it is clean and fast.
- **Why not mlx-audio:** it would be faster on Metal, but there is an open report of Kokoro producing NaN/silent output in mlx-audio 0.4.x (https://huggingface.co/mlx-community/Kokoro-82M-bf16/discussions/5), and it pulls in more dependencies. It's the obvious next speed-up to try.

**Measured caveat:** with onnxruntime's defaults (a thread per core, spin-waiting), the same episode took **~40× longer** on this Mac while other heavy dev servers and indexers were running (load average 5–7). The server now uses a bounded pool without spinning (`KOKORO_THREADS`, default half the cores, max 6). Under that contention it still ran at only about 0.2× real-time, so expect anywhere from ~30 s to ~15 min per episode on a laptop, depending on load.

## 3. The voice step: cloud

Cost per **10-minute episode (9,000 characters)**, and for **our measured 4-minute episodes (~3,500 characters)**:

| Service | Price | 10 min | 4 min | Free tier | Source |
|---|---|---|---|---|---|
| Polly Standard | $4 / 1M chars | $0.036 | $0.014 | 5M chars/mo (12 mo) | https://aws.amazon.com/polly/pricing/ |
| **Polly Neural** (in ap-southeast-2) | $16 / 1M | **$0.144** | **$0.056** | 1M chars/mo (12 mo) | same; [neural voices](https://docs.aws.amazon.com/polly/latest/dg/neural-voices.html) |
| Polly Generative (in ap-southeast-2) | $30 / 1M | $0.27 | $0.105 | 100k/mo (12 mo) | [generative voices](https://docs.aws.amazon.com/polly/latest/dg/generative-voices.html) (the Sydney price list only showed Standard/Neural SKUs) |
| Polly Long-Form | $100 / 1M | $0.90 | — | — | **us-east-1 only**: not usable here |
| OpenAI tts-1 / tts-1-hd | $15 / $30 per 1M | $0.135 / $0.27 | $0.05 / $0.11 | none | https://developers.openai.com/api/docs/pricing |
| OpenAI gpt-4o-mini-tts | ~$0.015/min (third-party estimate) | ~$0.15 | ~$0.06 | none | same |
| ElevenLabs (Creator, $22/mo) | 1M "v4" / 2M Flash chars | ~$0.20 / ~$0.10 | ~$0.08 / ~$0.04 | 10–20k chars/mo | https://elevenlabs.io/pricing/api (overage rates looked inconsistent) |
| Google Neural2 / Chirp 3 HD / Studio | $16 / $30 / $160 per 1M | $0.144 / $0.27 / $1.44 | — | 1M/mo | https://cloud.google.com/text-to-speech/pricing |
| Cartesia Sonic | ~$39–65 / 1M | ~$0.35–0.45 | — | 20k credits/mo | https://cartesia.ai/pricing |
| Azure Neural (Australia East) | $15 / 1M | $0.135 | — | 0.5M/mo | Azure Retail Prices API |

**Running Kokoro on AWS (my estimates, not tested):**
- **Lambda** (container image, 10 GB, ~6 vCPU): at ~2–8× real-time, about $0.01–0.05 per 10-minute episode. It fits the 15-minute limit and is billed only when used.
- **Fargate ARM** (2 vCPU / 4 GB, $0.03885 per vCPU-h + $0.00426 per GB-h in Sydney): about $0.016 for a 10-minute job.
- **Catch:** a Python container image plus a 325 MB model is new infra to build and patch. Polly needs none.

## 4. Recommendation

| | Local dev (this Mac) | AWS (ap-southeast-2) |
|---|---|---|
| Script | Claude Code CLI (`sonnet`): $0 extra on your login. Priced as the API at ~$0.02 per episode. | Anthropic API, Sonnet 5.5: **~$0.02–0.04** per episode |
| Voice | **Kokoro-82M**, local, Apache-2.0: **$0** | **Polly neural** (Olivia + Matthew): **~$0.06 (4 min) – $0.14 (10 min)**. Free for 12 months up to 1M chars/month (~280 of our episodes). |
| Total per episode | **$0** | **~$0.08–0.18**, once per article version, shared by all users |
| Why | Free, private, good quality, no system installs | Zero new compute: the existing Node worker Lambda calls Polly in-Region |

**Next step if volume grows:** Kokoro in a Lambda container (~$0.01–0.05 per episode, better voices than Polly neural). Polly generative ($0.27 per 10 minutes) is worth an A/B listen first.
