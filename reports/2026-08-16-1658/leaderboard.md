# openledger eval — 2026-08-16T09:58:02.127Z

oled `0.23.3` · skill `0.23.3` `4f29b02f4345` · prompts `5127b3c3f839` · eval `0.3.0`
suites: ingest, record, query · trials: 1 · concurrency: 2

## ingest

| # | Model | Cases | Pass rate | Avg time | Avg tokens | Cost | Tool calls | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 🥇 | x-ai/grok-4.6 | 1/1 | 100.0% | 5m03s | 312.2K / 24.9K | $0.7738 | 22.0 |  |
| 2 🥈 | deepseek/deepseek-v4-flash | 1/1 | 100.0% | 6m26s | 730K / 39.1K | $0.0497 | 47.0 |  |
| 3 🥉 | qwen/qwen3.8-27b | 1/1 | 100.0% | 40m00s | 819.8K / 59.7K | $0.5601 | 31.0 |  |

## record

| # | Model | Cases | Pass rate | Avg time | Avg tokens | Cost | Tool calls | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 🥇 | qwen/qwen3.8-27b | 5/5 | 100.0% ±0.0 | 8m25s | 121.4K / 12.9K | $0.4794 | 60.6 |  |
| 2 🥈 | x-ai/grok-4.6 | 5/5 | 100.0% ±0.0 | 1m23s | 141.3K / 5.4K | $1.5744 | 53.4 |  |
| 3 🥉 | deepseek/deepseek-v4-flash | 5/5 | 100.0% ±0.0 | 2m09s | 176K / 10.2K | $0.0604 | 64.4 |  |

## query

| # | Model | Cases | Pass rate | Avg time | Avg tokens | Cost | Tool calls | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 🥇 | deepseek/deepseek-v4-flash | 12/12 | 100.0% ±0.0 | 14s | 17.2K / 1.1K | $0.0143 | 3.8 |  |
| 2 🥈 | x-ai/grok-4.6 | 12/12 | 100.0% ±0.0 | 13s | 18.9K / 637 | $0.4986 | 6.9 |  |
| 3 🥉 | qwen/qwen3.8-27b | 12/12 | 100.0% ±0.0 | 1m14s | 18.5K / 1.5K | $0.1562 | 5.0 |  |
