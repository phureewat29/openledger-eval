# openledger eval — 2026-08-10T05:29:43.455Z

oled `0.22.0` · skill `0.22.0` `2cf3269d1708` · prompts `71f7daa6f630` · eval `0.3.0`
suites: ingest, record, query · trials: 1 · concurrency: 2

> **This report spans more than one build: oled 0.22.0 → 0.23.0, SKILL.md 2cf3269d1708 → 63fcbb99be83, the prompts 71f7daa6f630 → 5127b3c3f839.** A rerun landed here measured against something else.

## ingest

| # | Model | Cases | Pass rate | Avg time | Avg tokens | Cost | Tool calls | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 🥇 | openai/gpt-5.6-terra | 1/1 | 100.0% | 1m57s | 262.9K / 10.9K | $0.3283 | 15.0 |  |
| 2 🥈 | deepseek/deepseek-v4-flash | 1/1 | 100.0% | 6m41s | 779.7K / 36.3K | $0.1193 | 43.0 |  |

## record

| # | Model | Cases | Pass rate | Avg time | Avg tokens | Cost | Tool calls | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 🥇 | openai/gpt-5.6-terra | 5/5 | 100.0% ±0.0 | 43s | 90K / 2.8K | $0.5352 | 32.4 |  |
| 2 🥈 | deepseek/deepseek-v4-flash | 5/5 | 100.0% ±0.0 | 2m56s | 142.7K / 8.4K | $0.1117 | 58.2 |  |

## query

| # | Model | Cases | Pass rate | Avg time | Avg tokens | Cost | Tool calls | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 🥇 | openai/gpt-5.6-terra | 12/12 | 100.0% ±0.0 | 7s | 9.4K / 216 | $0.1278 | 4.1 |  |
| 2 🥈 | deepseek/deepseek-v4-flash | 12/12 | 100.0% ±0.0 | 24s | 16.7K / 1.2K | $0.0321 | 3.7 |  |
