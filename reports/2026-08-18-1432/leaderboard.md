# openledger eval — 2026-08-18T07:32:09.536Z

oled `0.23.3` · skill `0.23.3` `4f29b02f4345` · prompts `5127b3c3f839` · eval `0.3.0`
suites: ingest, record, query · trials: 1 · concurrency: 2

## ingest

| # | Model | Cases | Pass rate | Avg time | Avg tokens | Cost | Tool calls | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 🥇 | openai/gpt-5.6-luna | 1/1 | 100.0% | 2m25s | 597.1K / 14.7K | $0.1371 | 24.0 |  |
| 2 🥈 | qwen/qwen3.8-27b | 1/1 | 100.0% | 59m03s | 650.6K / 56.6K | $0.4740 | 27.0 |  |
| 3 🥉 | deepseek/deepseek-v4-flash | 1/1 | 100.0% | 15m46s | 683.1K / 43.7K | $0.0636 | 34.0 |  |
| 4 | x-ai/grok-4.6 | 0/1 | 91.7% | 5m53s | 407K / 26.4K | $0.9721 | 36.0 |  |
| 5 | anthropic/claude-haiku-4.5 | 0/1 | 16.7% | 6m51s | 1.7M / 34.8K | $1.8852 | 19.0 |  |

## record

| # | Model | Cases | Pass rate | Avg time | Avg tokens | Cost | Tool calls | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 🥇 | openai/gpt-5.6-luna | 5/5 | 100.0% ±0.0 | 47s | 100.6K / 3.5K | $0.1215 | 36.4 |  |
| 2 🥈 | x-ai/grok-4.6 | 5/5 | 100.0% ±0.0 | 1m21s | 104K / 5.1K | $1.1925 | 44.0 |  |
| 3 🥉 | qwen/qwen3.8-27b | 5/5 | 100.0% ±0.0 | 9m02s | 121.3K / 8.7K | $0.4119 | 63.6 |  |
| 4 | deepseek/deepseek-v4-flash | 5/5 | 100.0% ±0.0 | 3m51s | 122.3K / 8.6K | $0.0576 | 49.8 |  |
| 5 | anthropic/claude-haiku-4.5 | 4/5 | 98.9% ±2.5 | 58s | 170K / 6.1K | $1.0014 | 10.0 |  |

## query

| # | Model | Cases | Pass rate | Avg time | Avg tokens | Cost | Tool calls | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 🥇 | openai/gpt-5.6-luna | 12/12 | 100.0% ±0.0 | 11s | 16.7K / 371 | $0.0454 | 6.3 |  |
| 2 🥈 | deepseek/deepseek-v4-flash | 12/12 | 100.0% ±0.0 | 36s | 19.7K / 1.1K | $0.0217 | 3.8 |  |
| 3 🥉 | x-ai/grok-4.6 | 12/12 | 100.0% ±0.0 | 15s | 20.3K / 673 | $0.5351 | 7.3 |  |
| 4 | qwen/qwen3.8-27b | 12/12 | 100.0% ±0.0 | 1m46s | 26.9K / 1.4K | $0.2005 | 4.6 |  |
| 5 | anthropic/claude-haiku-4.5 | 9/12 | 87.5% ±22.6 | 9s | 19K / 647 | $0.2664 | 2.9 |  |
