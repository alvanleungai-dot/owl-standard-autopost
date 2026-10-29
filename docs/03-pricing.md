# Pricing — running one page (pilot)

Grounded estimate (USD) for **one Facebook page** at ~24 posts/month (5–6/week). Config: **Haiku writes · Perplexity researches · every post is a gpt-image image post.** Three usage-based vendors, no subscription floor (Perplexity needs prepaid credits).

Image prices are firm (verified Jun 2026). Research/text costs are estimates but small in every tier.

## Unit costs (USD, verified)
| Item | Price |
|---|---|
| Writing — Claude Haiku 4.5 | $1.00 / 1M in · $5.00 / 1M out |
| Research — Perplexity Sonar | $1 / 1M tokens + $5–12 / 1,000 requests (~$0.012/call) |
| Image — gpt-image low / medium / high (1024²) | $0.011 / $0.042 / $0.167 |

## Research vendor is ~a wash (per researched post)
| Vendor | ~ per call |
|---|---|
| Perplexity Sonar ✅ | ~$0.012 |
| ChatGPT (GPT-5 + web search) | ~$0.018 |
| Claude web search | ~$0.020 |
All ~1–2¢ → research vendor changes the monthly total by < $0.20. Pick on quality.

## One page — every post an image (~24 posts/month)
| | Medium images | High images |
|---|---|---|
| ~ per post | ~$0.06 | ~$0.18 |
| **One-time launch (~25 posts)** | **~$1.50** | **~$4.60** |
| **Monthly ongoing (24 posts)** | **~$1.40** | **~$4.40** |

Monthly split (medium): text ~$0.26 · research ~$0.14 · images ~$1.01.

## Notes
- **Image quality is the whole cost decision** — text + research are pennies.
- **Image model = gpt-image-2, NOT DALL·E 3.** gpt-image-2 ≈99% text accuracy (native Chinese); DALL·E 3 ≈60% (garbles Chinese regardless of setting). Chinese is good even at **medium** quality — only avoid the mini/low tier. Totals above hold (gpt-image-2 medium ≈ gpt-image-1 medium $0.042). High quality (~$0.17–0.21) only for hero polish.
- **Scaling:** ~6× for all six brands → ~$8–26/month depending on image quality.
- **Keys (3):** `ANTHROPIC_API_KEY` · `OPENAI_API_KEY` · `PERPLEXITY_API_KEY`.

## Sources
- gpt-image: [OpenAI API pricing](https://openai.com/api/pricing/) · [image price calculator](https://costgoat.com/pricing/openai-images)
- Perplexity: [Sonar API pricing](https://docs.perplexity.ai/docs/getting-started/pricing)
- Claude: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
