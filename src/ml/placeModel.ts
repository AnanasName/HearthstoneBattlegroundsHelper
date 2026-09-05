import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { APP_PATHS } from '../app/paths.js';
import type { GameState } from '../state/types.js';
import type { DatasetGame } from './dataset.js';
import { evaluateLogo, RIDGE_LAMBDA, summarizeEvals, toMlGame } from './evaluate.js';
import { extractHistoryFeatures, HISTORY_FEATURE_NAMES } from './historyFeatures.js';
import { lobbyKnownInState } from './relativeFeatures.js';
import { clampPlace, fitRidge, predictRidge, type RidgeModel } from './ridge.js';

/**
 * СНАПШОТ модели прогноза места — то, чем оверлей считает «ожидаемое место».
 *
 * ## Почему снапшот, а не обучение в рантайме
 *
 * Датасет есть у нас и нет у исполнителя: приложение ставится инсталлятором,
 * и `%LOCALAPPDATA%\hs-bg-assistant\dataset` у свежей установки пуст. Модель,
 * обучающаяся при старте, у нас работала бы, а у всех прочих молчала — тот же
 * класс расхождения, что пути от рабочего каталога (`src/app/paths.ts`).
 * Поэтому веса — ДАННЫЕ, как снапшот карт и статистика Firestone: файл
 * в `data/ml/`, обновляемый явной командой (`npm run ml:fit`), закоммиченный
 * и уезжающий в сборку через `extraResources`.
 *
 * Второе следствие того же решения: числа на экране («типичная ошибка»)
 * считаются ТОГДА ЖЕ, что и веса, и лежат в том же файле. Иначе подпись
 * и модель разъедутся молча — веса переобучат, а ошибка на экране останется
 * от прошлой выборки.
 *
 * ## Почему признаки замера 4
 *
 * Право на строку в оверлее дают ДВА замера — 1 (семь «своих» признаков)
 * и 4 (пять относительных плюс три по истории), оба взяли свои критерии
 * 05.09.2026 на 43 партиях. Взят замер 4: у него лучше все числа
 * (MAE 1.689 против 1.779 у замера 1 при константе 1.790, D̄ 0.495 против
 * 0.405) и он ОДИН взял условие «сигнал сверх сжатия места к среднему»
 * (D̄₂ 0.104 при МРЭ₂ 0.091) — то есть про модель замера 1 нельзя даже
 * сказать, что она читает борд, а не жмёт место к 3.6. Замер 3 остался
 * НЕ ДОКАЗАНО и в рантайм не идёт.
 *
 * ## Что здесь НЕ делается
 *
 * Обучение на всех партиях — это ВЕСА, а не оценка качества. Ошибка,
 * которую показывает оверлей, берётся из LOGO того же прогона (партия
 * предсказана моделью, обученной на остальных): подставить сюда ошибку
 * на обучающей выборке значило бы обещать точность, которой у прогноза
 * на новой партии нет.
 */

/** Файл снапшота: данные, а не код, — рядом с картами и статистикой. */
export const PLACE_MODEL_PATH = join(APP_PATHS.dataDir, 'ml', 'place-model.json');

export interface PlaceModelSnapshot {
  /** Когда обучено — снапшот устаревает с патчем, как и карты. */
  readonly fittedAt: string;
  /** Набор признаков; сегодня один — замер 4 (docs/ml.md). */
  readonly features: 'history';
  readonly featureNames: readonly string[];
  readonly lambda: number;
  /** Паспорт выборки: по чему обучено. */
  readonly games: number;
  readonly points: number;
  readonly builds: readonly number[];
  /** Числа LOGO того же прогона — «типичная ошибка» и её бейзлайны. */
  readonly maeModel: number;
  readonly maeCurrent: number;
  readonly maeMean: number;
  readonly dBar: number;
  readonly model: RidgeModel;
}

/** Партии, годные для обучения: относительные признаки требуют таблицы лобби. */
export function usableForPlaceModel(games: readonly DatasetGame[]): readonly DatasetGame[] {
  return games.filter((g) => g.record.checkpoints.every((cp) => lobbyKnownInState(cp.state)));
}

/**
 * Обучение снапшота: веса — на ВСЕХ точках выборки, числа ошибки — LOGO.
 * Обе процедуры те же, что в замере, и берутся из тех же функций: прибор
 * замера и прибор продукта обязаны считать одно, иначе подпись на экране
 * относится к другой модели.
 */
export function fitPlaceModel(games: readonly DatasetGame[], now: Date): PlaceModelSnapshot {
  const mlGames = games.map((g) => toMlGame(g, extractHistoryFeatures));

  const rows: (readonly number[])[] = [];
  const ys: number[] = [];
  for (const g of mlGames) {
    for (const row of g.rows) {
      rows.push(row);
      ys.push(g.finalPlace);
    }
  }

  const summary = summarizeEvals(evaluateLogo(mlGames, RIDGE_LAMBDA, 'global'));
  const builds = [
    ...new Set(
      games
        .map((g) => g.record.buildNumber)
        .filter((b): b is number => b !== null),
    ),
  ].sort((a, b) => a - b);

  return {
    fittedAt: now.toISOString(),
    features: 'history',
    featureNames: HISTORY_FEATURE_NAMES,
    lambda: RIDGE_LAMBDA,
    games: mlGames.length,
    points: rows.length,
    builds,
    maeModel: summary.maeModel,
    maeCurrent: summary.maeCurrent,
    maeMean: summary.maeMean,
    dBar: summary.maeCurrent - summary.maeModel,
    model: fitRidge(rows, ys, RIDGE_LAMBDA),
  };
}

/**
 * Прогноз места по точке и истории партии.
 *
 * `states` — точки решения партии по порядку, `index` — та, про которую
 * спрашиваем: признаки по истории (замер 4) читают точки ДО текущей,
 * и передавать сюда одно состояние нельзя — прогноз молча посчитался бы
 * на нулевой истории, то есть по другой модели, чем обучали.
 *
 * `null` — таблицы лобби нет: четыре признака из пяти относительных
 * считаются по столу, и на пустой таблице это не пропуск, а ложь
 * (то же правило, что в отборе партий замера).
 */
export function forecastPlace(
  snapshot: PlaceModelSnapshot,
  states: readonly GameState[],
  index: number,
): number | null {
  const state = states[index];
  if (state === undefined || !lobbyKnownInState(state)) return null;
  const row = extractHistoryFeatures(state, index, states);
  return clampPlace(predictRidge(snapshot.model, row));
}

/** Снапшот с диска; `null` — файла нет (свежая установка до `ml:fit`). */
export function loadPlaceModel(path: string = PLACE_MODEL_PATH): PlaceModelSnapshot | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as PlaceModelSnapshot;
}
