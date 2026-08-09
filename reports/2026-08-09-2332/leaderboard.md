# openledger eval — 2026-08-09T16:32:45.835Z

oled `0.22.0` · skill `0.22.0` `2cf3269d1708` · questions `707c0cace937` · eval `0.3.0`
suites: ingest, record, query · trials: 1 · concurrency: 2

## ingest

| # | Model | Cases | Pass rate | Avg time | Avg tokens | Cost | Tool calls | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 🥇 | openai/gpt-5.6-luna | 1/1 | 100.0% | 1m50s | 167.4K / 12.3K | $0.0241 | 10.0 |  |
| 2 🥈 | google/gemini-3.6-flash | 1/1 | 100.0% | 3m05s | 347K / 43.7K | $0.8486 | 15.0 |  |
| 3 🥉 | x-ai/grok-4.5 | 1/1 | 100.0% | 4m22s | 477.7K / 19.3K | $1.0710 | 42.0 |  |
| 4 | anthropic/claude-sonnet-5 | 1/1 | 100.0% | 5m12s | 707.6K / 34.7K | $1.7620 | 33.0 |  |
| 5 | deepseek/deepseek-v4-flash | 1/1 | 100.0% | 7m25s | 2.5M / 32.9K | $0.3539 | 54.0 |  |

## record

| # | Model | Cases | Pass rate | Avg time | Avg tokens | Cost | Tool calls | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 🥇 | openai/gpt-5.6-luna | 5/5 | 100.0% ±0.0 | 47s | 102.8K / 3.9K | $0.0631 | 55.4 |  |
| 2 🥈 | x-ai/grok-4.5 | 5/5 | 100.0% ±0.0 | 58s | 111.9K / 2.9K | $1.2064 | 44.8 |  |
| 3 🥉 | anthropic/claude-sonnet-5 | 5/5 | 100.0% ±0.0 | 1m18s | 120.8K / 6.2K | $1.5178 | 39.8 |  |
| 4 | deepseek/deepseek-v4-flash | 5/5 | 100.0% ±0.0 | 2m20s | 137.1K / 9.3K | $0.1090 | 55.4 |  |
| 5 | google/gemini-3.6-flash | 4/5 | 95.3% ±10.5 | 1m22s | 158K / 11.9K | — | 30.0 |  |

## query

| # | Model | Cases | Pass rate | Avg time | Avg tokens | Cost | Tool calls | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 🥇 | openai/gpt-5.6-luna | 12/12 | 100.0% ±0.0 | 9s | 16.4K / 324 | $0.0220 | 5.3 |  |
| 2 🥈 | x-ai/grok-4.5 | 12/12 | 100.0% ±0.0 | 14s | 19.1K / 591 | $0.5021 | 5.8 |  |
| 3 🥉 | deepseek/deepseek-v4-flash | 12/12 | 100.0% ±0.0 | 18s | 18.8K / 1.2K | $0.0358 | 4.3 |  |
| 4 | anthropic/claude-sonnet-5 | 12/12 | 100.0% ±0.0 | 15s | 23.1K / 632 | $0.6294 | 3.8 |  |
| 5 | google/gemini-3.6-flash | 12/12 | 100.0% ±0.0 | 14s | 40.2K / 2.3K | — | 4.5 |  |
