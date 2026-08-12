import type { SimulationResult } from '@firestone-hs/simulate-bgs-battle/dist/simulation-result.js';

/**
 * Оценка расстановки и то, как из неё получается число для сравнения.
 *
 * Оценка хранится **счётчиками, а не процентами**, и это принципиально.
 * Поиск возвращается к выжившим кандидатам и досчитывает им симуляции;
 * складывать счётчики двух прогонов можно точно, а усреднять проценты —
 * только приблизительно и с потерей веса. Из счётчиков же берётся честная
 * стандартная ошибка, без которой топ-3 выглядит точнее, чем он есть.
 */

export interface Estimate {
  /** Сколько симуляций сложилось в эту оценку. */
  readonly sims: number;
  readonly won: number;
  readonly tied: number;
  readonly lost: number;
  /** Побед, в которых противник умирает. */
  readonly wonLethal: number;
  /** Поражений, в которых умираем мы. */
  readonly lostLethal: number;
  /** Суммарный нанесённый урон по всем победам. */
  readonly damageWon: number;
  /** Суммарный полученный урон по всем поражениям. */
  readonly damageLost: number;
}

export const EMPTY_ESTIMATE: Estimate = {
  sims: 0,
  won: 0,
  tied: 0,
  lost: 0,
  wonLethal: 0,
  lostLethal: 0,
  damageWon: 0,
  damageLost: 0,
};

/**
 * Итог прогона симулятора в наши счётчики.
 *
 * Проценты пакета для этого не годятся: `wonPercent` округлён до десятой доли,
 * а `checkRounding` подменяет крайние значения на 0.01 и 99.9. Сырые поля
 * `won`/`tied`/`lost` — это штуки, и складываются они без потерь.
 */
export function toEstimate(result: SimulationResult): Estimate {
  return {
    sims: result.won + result.tied + result.lost,
    won: result.won,
    tied: result.tied,
    lost: result.lost,
    wonLethal: result.wonLethal,
    lostLethal: result.lostLethal,
    damageWon: result.damageWon,
    damageLost: result.damageLost,
  };
}

export function mergeEstimates(a: Estimate, b: Estimate): Estimate {
  return {
    sims: a.sims + b.sims,
    won: a.won + b.won,
    tied: a.tied + b.tied,
    lost: a.lost + b.lost,
    wonLethal: a.wonLethal + b.wonLethal,
    lostLethal: a.lostLethal + b.lostLethal,
    damageWon: a.damageWon + b.damageWon,
    damageLost: a.damageLost + b.damageLost,
  };
}

const rate = (part: number, total: number): number => (total === 0 ? 0 : part / total);

export const winRate = (e: Estimate): number => rate(e.won, e.sims);
export const tieRate = (e: Estimate): number => rate(e.tied, e.sims);
export const lossRate = (e: Estimate): number => rate(e.lost, e.sims);
/** Доля симуляций, в которых игрок умирает. */
export const deathRate = (e: Estimate): number => rate(e.lostLethal, e.sims);
/** Доля симуляций, в которых умирает противник. */
export const killRate = (e: Estimate): number => rate(e.wonLethal, e.sims);

/**
 * Ожидаемый размен здоровьем за бой: сколько снимем минус сколько получим.
 *
 * Делится на все симуляции, а не только на победные, — это средний исход боя,
 * а не средний размер победы.
 */
export const netDamage = (e: Estimate): number => rate(e.damageWon - e.damageLost, e.sims);

/**
 * Стандартная ошибка доли побед.
 *
 * Нужна не для красоты: при 300 симуляциях она около 3 п.п., а разница между
 * хорошей и отличной расстановкой часто 1–3 п.п. Без этой величины советник
 * выдавал бы порядок, которого в данных нет.
 */
export function winRateError(e: Estimate): number {
  if (e.sims === 0) return 0.5;
  const p = winRate(e);
  return Math.sqrt((p * (1 - p)) / e.sims);
}

/**
 * Чем расстановки сравниваются.
 *
 *  - `winRate` — доля побед. Формулировка ТЗ, значение по умолчанию.
 *  - `netDamage` — ожидаемый размен здоровьем. Осмысленнее, когда победа
 *    недостижима и вопрос только в том, сколько урона пропустить.
 *  - `survival` — сначала не умереть, потом всё остальное. Для ходов, где
 *    здоровья осталось меньше, чем противник способен нанести.
 */
export type Objective = 'winRate' | 'netDamage' | 'survival';

export const OBJECTIVES: Readonly<Record<Objective, (e: Estimate) => number>> = {
  // Ничья лучше поражения, но не равна победе; половина веса — не подгонка,
  // а прямое следствие того, что при ничьей здоровье не теряет никто.
  winRate: (e) => winRate(e) + 0.5 * tieRate(e),
  netDamage: (e) => netDamage(e),
  // Смерть перевешивает всё: партия на этом кончается, а бой — нет.
  survival: (e) => -deathRate(e),
};

/**
 * Чем разводить расстановки, у которых величина сравнения совпала до цифры.
 *
 * Такое случается чаще, чем кажется: в безнадёжном бою все расстановки
 * проигрывают в ста процентах случаев, а выбирать из чего-то надо.
 *
 * Довесок держится строго отдельно от величины сравнения, и это не педантизм.
 * Пока он входил в неё слагаемым, проверка значимости объявляла различимыми
 * расстановки, у которых совпало всё, кроме среднего урона: при нулевой
 * дисперсии исходов стандартная ошибка равна нулю, и сколь угодно малая
 * разница проходила любой порог. Советник на этом честно рекомендовал
 * перестановку с выигрышем «+0.0 п.п.» — видно на ходах 4 и 6 фикстуры part3.
 */
const TIE_BREAKS: Readonly<Record<Objective, (e: Estimate) => number>> = {
  winRate: netDamage,
  netDamage: (e) => winRate(e) + 0.5 * tieRate(e),
  survival: (e) => winRate(e) + 0.5 * tieRate(e),
};

/** Величина сравнения без довеска — по ней считаются значимость и выигрыш. */
export function objectiveOf(e: Estimate, objective: Objective): number {
  return OBJECTIVES[objective](e);
}

/** Очки для упорядочивания: величина сравнения плюс разводящий довесок. */
export function scoreOf(e: Estimate, objective: Objective): number {
  return objectiveOf(e, objective) + 1e-6 * TIE_BREAKS[objective](e);
}

/**
 * Стандартная ошибка самой величины сравнения.
 *
 * Считать её по доле побед было ошибкой, и она видна на фикстуре: на ходу 14
 * part3 все расстановки выигрывают в 0% случаев, а различаются долей ничьих —
 * 97.4% против 99.1%. По доле побед разницы нет вовсе, и советник объявлял
 * улучшение шумом, хотя оно втрое сокращало шанс проиграть бой.
 *
 * Для `winRate` величина сравнения принимает три значения: 1 за победу,
 * 0.5 за ничью, 0 за поражение. Её дисперсия считается из счётчиков точно,
 * без обращения к отдельным симуляциям.
 *
 * Для `netDamage` вернуть нечего: симулятор отдаёт только сумму урона, а массив
 * поединков очищает, поэтому разброс урона по боям нам неизвестен. Врать
 * правдоподобным числом хуже, чем признать отсутствие.
 */
export function scoreError(e: Estimate, objective: Objective): number | null {
  if (e.sims === 0) return 0.5;

  /**
   * Пол для ошибки: половина исхода на выборку.
   *
   * Нужен там, где ни одного события не наблюдалось вовсе — например все бои
   * проиграны. Формула даёт тогда ровно ноль, то есть абсолютную уверенность
   * из наблюдения, которого не было. Полом порог превращается примерно
   * в «разница хотя бы в полтора исхода», что для нулевой выборки честнее.
   */
  const floor = 0.5 / e.sims;

  switch (objective) {
    case 'winRate': {
      const mean = (e.won + 0.5 * e.tied) / e.sims;
      const meanOfSquares = (e.won + 0.25 * e.tied) / e.sims;
      return Math.max(floor, Math.sqrt(Math.max(0, meanOfSquares - mean * mean) / e.sims));
    }
    case 'survival': {
      const p = deathRate(e);
      return Math.max(floor, Math.sqrt((p * (1 - p)) / e.sims));
    }
    case 'netDamage':
      return null;
  }
}

/**
 * Различимы ли две оценки, или разница целиком в пределах шума.
 *
 * Порог в два стандартных отклонения разности — это примерно 95% уверенности
 * для нормального приближения. Возвращается именно «различимы», а не p-value:
 * советнику нужно решение, показывать ли перестановку как улучшение.
 *
 * Когда ошибка неизвестна (цель `netDamage`), проверка откатывается на исходы
 * боя: если распределение побед, ничьих и поражений неотличимо, то и разницу
 * в среднем уроне показывать как улучшение не за что.
 */
export function distinguishable(a: Estimate, b: Estimate, objective: Objective = 'winRate'): boolean {
  const errorA = scoreError(a, objective);
  const errorB = scoreError(b, objective);

  if (errorA === null || errorB === null) return distinguishable(a, b, 'winRate');

  const error = Math.hypot(errorA, errorB);
  return Math.abs(objectiveOf(a, objective) - objectiveOf(b, objective)) > 2 * error;
}
