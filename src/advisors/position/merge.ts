import type { PositionAdvice } from './advisor.js';
import { EMPTY_ESTIMATE, mergeEstimates, scoreOf, type Estimate, type Objective } from './score.js';

/**
 * Слияние советов нескольких НЕЗАВИСИМЫХ поисков.
 *
 * ## Зачем несколько поисков
 *
 * Поиск расстановки перебирает не всё: на борде из семи миньонов 5040
 * расстановок, а в отборочный бюджет влезает две сотни кандидатов. Какие
 * именно двести — решает поиск в ширину по лучшему, а «лучший» он выбирает
 * по зашумлённой оценке. Поэтому два поиска с разными зёрнами ходят разными
 * путями и находят разные окрестности.
 *
 * Восемь поисков на восьми ядрах — это восемь таких путей за то же время.
 * Выигрыш здесь НЕ в скорости: три-четыре секунды и так укладывались
 * в отпущенные ТЗ десять. Выигрыш в том, что просмотрено больше
 * пространства, а у финалистов больше симуляций за спиной.
 *
 * ## Почему выбор идёт по СОВОКУПНОЙ улике
 *
 * Наивное «взять совет с лучшей оценкой» — это максимум по восьми шумным
 * числам, то есть ровно та ошибка, ради которой в поиске заведены финальные
 * раунды: наверх выходит самый удачливый, а не лучший. Поэтому оценки
 * кандидата СКЛАДЫВАЮТСЯ по всем поискам, которые его видели (счётчики
 * складываются точно, `mergeEstimates`), и сравниваются уже суммы.
 *
 * Расстановку, найденную одним поиском из восьми, это не выбрасывает: её
 * сумма — это её собственные симуляции. Но чтобы обойти расстановку,
 * которую восемь поисков видели и оценили, ей нужна разница, а не везение.
 *
 * ## Почему возвращается ЧУЖОЙ совет целиком, а не собранный заново
 *
 * В совете есть поля, которые считаются по справочнику карт: тай-брейк
 * по ражу и приписка к нему (`preferRallySwing`, `rallySwingNote`).
 * Справочник живёт в воркере, а слияние идёт в главном потоке. Собирать
 * совет здесь значило бы либо тащить справочник во второй раз, либо
 * пересчитывать эти поля иначе, чем их считает советник, — и разойтись
 * с ним молча. Поэтому здесь только ВЫБОР: чей совет отдать наружу.
 */

/**
 * Стандартная ошибка величины сравнения.
 *
 * Для цели по умолчанию исход симуляции — это 1 за победу, 0.5 за ничью
 * и 0 за поражение, поэтому дисперсия считается честно по этим трём долям,
 * а не как у доли побед: ничьи иначе исчезли бы из погрешности, а в бою,
 * где всё решает «свести ли вничью», они и есть весь ответ.
 *
 * Для остальных целей берётся грубая верхняя граница: там величина сравнения
 * не доля, и точная формула стоила бы отдельного замера.
 */
function objectiveError(e: Estimate, objective: Objective): number {
  if (e.sims === 0) return 0.5;
  if (objective !== 'winRate') return 0.5 / Math.sqrt(e.sims);
  const win = e.won / e.sims;
  const tie = e.tied / e.sims;
  const mean = win + 0.5 * tie;
  const second = win + 0.25 * tie;
  return Math.sqrt(Math.max(0, second - mean * mean) / e.sims);
}

export interface SelectionOptions {
  /**
   * Сколько стандартных ошибок вычитать из оценки при сравнении.
   *
   * Ноль — сравнение точечных оценок: расстановка, которую видел один поиск
   * из восьми, сохраняет своё везение целиком. Больше нуля — расстановка
   * тем сильнее уценивается, чем меньше за ней симуляций, и чтобы победить
   * подтверждённую, ей нужна разница, а не удача.
   */
  readonly z: number;
}

export const DEFAULT_SELECTION: SelectionOptions = { z: 0 };

export interface PooledChoice {
  /** Номер поиска, чей совет выбран. */
  readonly index: number;
  /** Ключ выбранной расстановки. */
  readonly key: string;
  /** Сколько поисков посоветовали ту же расстановку. */
  readonly agreed: number;
  /** Совокупная оценка выбранной расстановки по всем поискам, которые её видели. */
  readonly pooled: Estimate;
}

/**
 * Совокупные оценки всех кандидатов, которых видел хоть один поиск.
 *
 * Внутри одного поиска ключ учитывается ОДИН раз: текущая расстановка лежит
 * и в `top`, и в `current` одной и той же оценкой, и сложить их значило бы
 * посчитать её симуляции дважды.
 */
export function poolCandidates(advices: readonly PositionAdvice[]): Map<string, Estimate> {
  const pooled = new Map<string, Estimate>();
  for (const advice of advices) {
    const own = new Map<string, Estimate>();
    for (const candidate of advice.top) own.set(candidate.key, candidate.estimate);
    own.set(advice.current.key, advice.current.estimate);
    for (const [key, estimate] of own) {
      pooled.set(key, mergeEstimates(pooled.get(key) ?? EMPTY_ESTIMATE, estimate));
    }
  }
  return pooled;
}

/**
 * Чей совет отдать наружу.
 *
 * `null` — советов не было вовсе. Совет без рекомендации (пустой `top`)
 * в выборе не участвует: рекомендовать ему нечего.
 *
 * Разводка при равной сумме — строго по порядку и без обращения ко времени,
 * чтобы ответ не зависел от того, какой воркер сегодня финишировал первым:
 * сперва согласие поисков, потом текущая расстановка, потом номер поиска.
 */
export function chooseAdvice(
  advices: readonly PositionAdvice[],
  objective: Objective,
  selection: SelectionOptions = DEFAULT_SELECTION,
): PooledChoice | null {
  const pooled = poolCandidates(advices);

  const agreement = new Map<string, number>();
  for (const advice of advices) {
    const best = advice.top[0];
    if (best !== undefined) agreement.set(best.key, (agreement.get(best.key) ?? 0) + 1);
  }

  let chosen: PooledChoice | null = null;
  let chosenScore = -Infinity;

  for (const [index, advice] of advices.entries()) {
    const best = advice.top[0];
    if (best === undefined) continue;
    // Тот же ключ уже мог победить от более раннего поиска — тогда его
    // и оставляем: совет по одной расстановке различается только полями,
    // а номер поиска берём наименьший ради воспроизводимости.
    if (chosen !== null && chosen.key === best.key) continue;

    const estimate = pooled.get(best.key) ?? best.estimate;
    const score = scoreOf(estimate, objective) - selection.z * objectiveError(estimate, objective);
    const agreed = agreement.get(best.key) ?? 1;

    if (chosen === null || better(score, agreed, best.key, chosenScore, chosen, advice)) {
      chosen = { index, key: best.key, agreed, pooled: estimate };
      chosenScore = score;
    }
  }

  return chosen;
}

function better(
  score: number,
  agreed: number,
  key: string,
  chosenScore: number,
  chosen: PooledChoice,
  advice: PositionAdvice,
): boolean {
  if (score !== chosenScore) return score > chosenScore;
  if (agreed !== chosen.agreed) return agreed > chosen.agreed;
  // При полном равенстве побеждает «оставить как есть»: просить игрока
  // переставить борд ради совпадения в последнем знаке — лишняя работа.
  if (key === advice.current.key) return true;
  if (chosen.key === advice.current.key) return false;
  return false;
}
