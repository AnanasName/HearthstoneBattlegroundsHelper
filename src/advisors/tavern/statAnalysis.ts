/**
 * Разбор дампа «кандидат покупки → исход боя»: помогает ли статистика карт.
 *
 * Здесь только арифметика по сохранённому дампу — ни одной симуляции.
 * Поэтому любой вес, срез или порог проверяется за секунды, а результат
 * от прогона к прогону не дрожит. Замер и его пороги описаны целиком
 * в docs/cardstats.md (предрегистрация закоммичена до прогона).
 *
 * ## Два принципа, без которых замер соврал бы
 *
 * 1. **Центрирование ВНУТРИ ХОДА.** Кандидаты разных ходов несравнимы:
 *    на ходу 3 выигрывают все, на ходу 15 — никто. Связь считается
 *    по отклонениям от среднего своего хода, иначе мерится «ход 3 против
 *    хода 15», а не польза признака.
 * 2. **Нуль — перестановка внутри ТИРА.** Статистика коллинеарна тиру
 *    (37% дисперсии), а тир у нас уже оплачен весом `perTechLevel`.
 *    Перестановка между картами одного тира сохраняет всё тировое
 *    и ломает только карто-специфическое — иначе замер подтвердит наш же
 *    вес тира. Переставляются КАРТЫ, а не строки: одна карта встречается
 *    в нескольких ходах, и построчная перестановка занизила бы нуль.
 */

export interface DumpRow {
  readonly fixture: string;
  readonly turn: number;
  readonly candIndex: number;
  readonly cardId: string;
  readonly name: string;
  readonly techLevel: number | null;
  readonly golden: boolean;
  readonly isHeuristicPick: boolean;
  readonly score: number;
  readonly v: Readonly<Record<string, number>>;
  readonly outcome: number;
  readonly sims: number;
  readonly stat: {
    readonly placement: number;
    readonly other: number;
    readonly impact: number;
    readonly residual: number;
    readonly totalPlayed: number;
  } | null;
  readonly statGain: number;
}

/** Ходы: строки дампа, сгруппированные по (партия, ход). */
export interface DecisionGroup {
  readonly key: string;
  readonly fixture: string;
  readonly turn: number;
  readonly rows: readonly DumpRow[];
}

export function groupByDecision(rows: readonly DumpRow[]): DecisionGroup[] {
  const groups = new Map<string, DumpRow[]>();
  for (const row of rows) {
    const key = `${row.fixture}|${String(row.turn)}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({
      key,
      fixture: list[0]?.fixture ?? '',
      turn: list[0]?.turn ?? 0,
      rows: [...list].sort((a, b) => a.candIndex - b.candIndex),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Ожидаемый исход выбора: победа плюс половина ничьей, уже в дампе. */
const outcomeOf = (row: DumpRow): number => row.outcome;

/**
 * Оценка одной конфигурации веса: что бы советник выбрал и чего это стоило.
 *
 * Переранжирование идёт ТОЛЬКО среди покупок: порядок прочих действий
 * от статистики не зависит по построению правила (docs/cardstats.md).
 */
export interface RankingResult {
  /** Средняя цена расхождения с лучшим по бою, п.п. */
  readonly averageCost: number;
  /**
   * Доля ходов, где выбор совпал с ПЕРВЫМ кандидатом, достигшим лучшего
   * исхода. Так считает `buyQuality`, и только по этой величине сверяется
   * шлюз методики — сравнивать с опубликованными числами можно лишь её.
   */
  readonly agreement: number;
  /**
   * Доля ходов, где выбор попал в ЛЮБОГО из кандидатов с лучшим исходом.
   *
   * Честная величина: ничьих за первое место 66 из 108 (исходы кандидатов
   * сплошь и рядом совпадают до цифры), и счёт «по первому максимуму»
   * бесплатно награждает конфигурацию, чей порядок совпал с исходным.
   * Падение совпадения по нему преувеличено вдвое.
   */
  readonly agreementAny: number;
  /** Исход выбора на каждом ходу — для парных разностей. */
  readonly pickedOutcome: readonly number[];
  /** Карта выбора на каждом ходу. */
  readonly pickedCardId: readonly string[];
  readonly turns: number;
}

export function rankWith(
  groups: readonly DecisionGroup[],
  lambda: number,
  gainOf: (row: DumpRow) => number = (row) => row.statGain,
): RankingResult {
  return rankByScore(groups, (row) => (row.v['total'] ?? 0) + lambda * gainOf(row));
}

/**
 * Ранжирование по произвольным очкам.
 *
 * Порядок при равенстве очков — исходный: строго `>` оставляет первым
 * кандидата эвристики, и λ=0 обязан воспроизвести её выбор точь-в-точь.
 */
export function rankByScore(
  groups: readonly DecisionGroup[],
  scoreOf: (row: DumpRow) => number,
): RankingResult {
  const pickedOutcome: number[] = [];
  const pickedCardId: string[] = [];
  let costSum = 0;
  let agreed = 0;
  let agreedAny = 0;

  for (const group of groups) {
    let best = group.rows[0];
    let bestScore = best === undefined ? 0 : scoreOf(best);
    for (const row of group.rows) {
      const s = scoreOf(row);
      if (s > bestScore) {
        best = row;
        bestScore = s;
      }
    }
    if (best === undefined) continue;

    const outcomes = group.rows.map(outcomeOf);
    const bestOutcome = Math.max(...outcomes);
    const bestRow = group.rows.find((r) => outcomeOf(r) === bestOutcome);

    pickedOutcome.push(outcomeOf(best));
    pickedCardId.push(best.cardId);
    costSum += bestOutcome - outcomeOf(best);
    if (bestRow !== undefined && bestRow.cardId === best.cardId) agreed += 1;
    // Ничья за первое место — обычное дело: выбрать любого из лучших
    // это одно и то же решение.
    if (outcomeOf(best) === bestOutcome) agreedAny += 1;
  }

  const turns = pickedOutcome.length;
  return {
    averageCost: turns === 0 ? 0 : costSum / turns,
    agreement: turns === 0 ? 0 : agreed / turns,
    agreementAny: turns === 0 ? 0 : agreedAny / turns,
    pickedOutcome,
    pickedCardId,
    turns,
  };
}

/** Парные разности цены между двумя конфигурациями, по ходам. */
export function pairedDeltas(base: RankingResult, other: RankingResult): number[] {
  return base.pickedOutcome.map((o, i) => (other.pickedOutcome[i] ?? o) - o);
}

export const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Сводка замера: сколько точек, среднее, его стандартная ошибка и сколько сдвинулось. */
export interface SpikeSummary {
  readonly n: number;
  readonly mean: number;
  readonly se: number;
  /** Точек, где разность выше шума округления, — остальные ветви тождественны. */
  readonly moved: number;
}

/**
 * Приёмочная арифметика замеров, одна на все спайки.
 *
 * Порог приёмки у нас всегда «среднее против 2·SE», а `moved` отделяет точки,
 * где ветви дали хоть какую-то разницу, от тождественных — без него выборка
 * выглядит больше, чем она есть (у замера провокации 47 точек из 62 были
 * тождественны). Формула живёт ЗДЕСЬ, потому что её числа записаны в docs
 * как предрегистрированный критерий: три копии в трёх спайках расходились бы
 * молча, и разошедшийся замер выглядел бы как новый результат.
 */
export function summarize(values: readonly number[]): SpikeSummary {
  const n = values.length;
  const divisor = Math.max(1, n);
  const m = mean(values);
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1);
  return {
    n,
    mean: m,
    se: Math.sqrt(variance / divisor),
    moved: values.filter((v) => Math.abs(v) > MOVED_EPSILON).length,
  };
}

/** Ниже этого разность считается нулём: ветви дали тождественный исход. */
const MOVED_EPSILON = 0.05;

/** Ранги с усреднением связок — для Спирмена. */
function ranks(values: readonly number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]?.v === order[i]?.v) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) {
      const idx = order[k]?.i;
      if (idx !== undefined) out[idx] = rank;
    }
    i = j + 1;
  }
  return out;
}

export function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] ?? 0) - mx;
    const dy = (ys[i] ?? 0) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
}

export function spearman(xs: readonly number[], ys: readonly number[]): number {
  return pearson(ranks(xs), ranks(ys));
}

/**
 * Центрирование внутри хода: из каждого значения вычитается среднее
 * по своему ходу. Так сравниваются кандидаты между собой, а не ходы.
 */
export function centerWithinDecision(
  groups: readonly DecisionGroup[],
  valueOf: (row: DumpRow) => number,
): number[] {
  const out: number[] = [];
  for (const group of groups) {
    const values = group.rows.map(valueOf);
    const m = mean(values);
    for (const v of values) out.push(v - m);
  }
  return out;
}

/**
 * Остаток одного вектора после линейной проекции на несколько других
 * (МНК через нормальные уравнения с гребневой добавкой).
 *
 * Нужен для строгого вопроса: несёт ли статистика то, чего НЕТ в наших
 * одиннадцати слагаемых. Если после вычитания их вклада связь исчезает —
 * статистика лишь перевзвешивает уже известное.
 */
export function residualAfter(target: readonly number[], predictors: readonly (readonly number[])[]): number[] {
  const n = target.length;
  const k = predictors.length;
  if (k === 0) return [...target];

  // X'X и X'y с константой не нужны: всё уже центрировано внутри хода.
  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty: number[] = new Array<number>(k).fill(0);
  for (let a = 0; a < k; a += 1) {
    const pa = predictors[a] ?? [];
    for (let b = 0; b < k; b += 1) {
      const pb = predictors[b] ?? [];
      let s = 0;
      for (let i = 0; i < n; i += 1) s += (pa[i] ?? 0) * (pb[i] ?? 0);
      const row = xtx[a];
      if (row !== undefined) row[b] = s + (a === b ? 1e-8 : 0);
    }
    let sy = 0;
    for (let i = 0; i < n; i += 1) sy += (pa[i] ?? 0) * (target[i] ?? 0);
    xty[a] = sy;
  }

  const beta = solve(xtx, xty);
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let fit = 0;
    for (let a = 0; a < k; a += 1) fit += (beta[a] ?? 0) * (predictors[a]?.[i] ?? 0);
    out[i] = (target[i] ?? 0) - fit;
  }
  return out;
}

/** Метод Гаусса с выбором ведущего элемента. */
function solve(a: readonly number[][], b: readonly number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] ?? 0]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(m[r]?.[col] ?? 0) > Math.abs(m[pivot]?.[col] ?? 0)) pivot = r;
    }
    const tmp = m[col];
    const pv = m[pivot];
    if (tmp !== undefined && pv !== undefined) {
      m[col] = pv;
      m[pivot] = tmp;
    }
    const prow = m[col];
    const lead = prow?.[col] ?? 0;
    if (prow === undefined || Math.abs(lead) < 1e-12) continue;
    for (let c = col; c <= n; c += 1) prow[c] = (prow[c] ?? 0) / lead;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const row = m[r];
      if (row === undefined) continue;
      const factor = row[col] ?? 0;
      if (factor === 0) continue;
      for (let c = col; c <= n; c += 1) row[c] = (row[c] ?? 0) - factor * (prow[c] ?? 0);
    }
  }
  return m.map((row) => row[n] ?? 0);
}

/** Детерминированный ГПСЧ для перестановок и бутстрапа — замер воспроизводим. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function shuffleInPlace<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = items[i];
    const b = items[j];
    if (a !== undefined && b !== undefined) {
      items[i] = b;
      items[j] = a;
    }
  }
  return items;
}

/**
 * Перестановка статистики МЕЖДУ КАРТАМИ ОДНОГО ТИРА.
 *
 * Возвращает функцию «строка → переставленный statGain». Тир сохраняется,
 * карто-специфическое ломается — это и есть честный нуль.
 */
export function permuteWithinTier(
  rows: readonly DumpRow[],
  rng: () => number,
): (row: DumpRow) => number {
  const gainByCard = new Map<string, number>();
  for (const row of rows) gainByCard.set(row.cardId, row.statGain);

  const tierOf = new Map<string, number>();
  for (const row of rows) tierOf.set(row.cardId, row.techLevel ?? 0);

  const byTier = new Map<number, string[]>();
  for (const [cardId, tier] of tierOf) {
    const list = byTier.get(tier) ?? [];
    list.push(cardId);
    byTier.set(tier, list);
  }

  const mapped = new Map<string, number>();
  for (const [, cardIds] of byTier) {
    const sorted = [...cardIds].sort();
    const gains = sorted.map((id) => gainByCard.get(id) ?? 0);
    shuffleInPlace(gains, rng);
    sorted.forEach((id, i) => mapped.set(id, gains[i] ?? 0));
  }
  return (row) => mapped.get(row.cardId) ?? 0;
}

/** Перцентиль отсортированной выборки. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx] ?? 0;
}
