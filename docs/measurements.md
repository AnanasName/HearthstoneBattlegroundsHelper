# Замеры

Файл генерирует `npm run battery`; руками его не правят. Сырые числа —
`data/measurements/*.json`, полный вывод скриптов — `data/measurements/logs/`
(не в git). В записях о партиях числа не переписываются: там стоит
вердикт и ссылка сюда.

**Последний полный прогон:** 2026-09-17 08:33, коммит 2c9871f, зерно 1, партий 52 (part4–part55).
**Сравнимого прошлого прогона нет** — с тем же зерном и тем же набором партий.
**Полосы шума нет:** `npm run battery -- --seeds=5` посчитает её один раз на коде.

## validate:tavern · 34 мин

| метрика | было | стало | Δ | шум (SD) | |
|---|---:|---:|---:|---:|---|
| turns | — | 516 | — | — |  |
| agreementPct | — | 75 | — | — |  |
| costPp | — | 3.18 | — | — |  |
| decisiveTurns | — | 182 | — | — |  |
| decisiveAgreementPct | — | 51.1 | — | — |  |
| decisiveCostPp | — | 8.85 | — | — |  |
| inSampleTurns | — | 217 | — | — |  |
| inSampleAgreementPct | — | 76 | — | — |  |
| inSampleCostPp | — | 2.93 | — | — |  |
| outOfSampleTurns | — | 299 | — | — |  |
| outOfSampleAgreementPct | — | 74.2 | — | — |  |
| outOfSampleCostPp | — | 3.36 | — | — |  |
| skippedNoBattle | — | 9 | — | — |  |
| skippedNoChoice | — | 137 | — | — |  |

## validate:spend · 39 мин

| метрика | было | стало | Δ | шум (SD) | |
|---|---:|---:|---:|---:|---|
| turns | — | 122 | — | — |  |
| agreementPct | — | 65.6 | — | — |  |
| costPp | — | 16.2 | — | — |  |
| decisiveTurns | — | 77 | — | — |  |
| sameShapeTurns | — | 81 | — | — |  |
| sameShapeAgreementPct | — | 74.1 | — | — |  |
| sameShapeCostPp | — | 6.79 | — | — |  |
| sameShapeDecisiveTurns | — | 42 | — | — |  |
| goldLeftPlan | — | 0.02 | — | — |  |
| goldLeftBest | — | 2.16 | — | — |  |
| inSampleTurns | — | 36 | — | — |  |
| inSampleAgreementPct | — | 72.2 | — | — |  |
| outOfSampleTurns | — | 45 | — | — |  |
| outOfSampleAgreementPct | — | 75.6 | — | — |  |
| skippedNoBattle | — | 9 | — | — |  |
| skippedNoChoice | — | 531 | — | — |  |

## calibrate · 18 мин

| метрика | было | стало | Δ | шум (SD) | |
|---|---:|---:|---:|---:|---|
| battles | — | 669 | — | — |  |
| actualWinPct | — | 49.5 | — | — |  |
| meanPredictedWinPct | — | 52.1 | — | — |  |
| calibrationGapPp | — | 2.7 | — | — |  |
| brier | — | 0.084 | — | — |  |
| outliers | — | 28 | — | — |  |
