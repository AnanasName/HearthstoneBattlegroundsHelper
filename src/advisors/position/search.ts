import type { Minion } from '../../state/types.js';
import { arrangementSpace } from './arrangements.js';
import { mulberry32 } from './rng.js';
import {
  EMPTY_ESTIMATE,
  mergeEstimates,
  scoreOf,
  type Estimate,
  type Objective,
} from './score.js';

/**
 * Поиск лучшей расстановки.
 *
 * Модуль ничего не знает про симулятор: оценщик передаётся снаружи. Так поиск
 * можно проверить на подставной функции с известным оптимумом, не гоняя
 * Монте-Карло и не гадая, что именно сломалось — алгоритм или маппинг.
 *
 * ## Почему не полный перебор
 *
 * Замеры (`npm run spike:position`): 120 мкс на симуляцию плюс 8.5 мс
 * постоянных на каждый вызов симулятора. Полный перебор 5040 расстановок
 * по 300 симуляций — это около четырёх минут в поток при бюджете ТЗ в 10 с.
 * На маленьких бордах перебор дешёв и делается целиком, на больших работает
 * локальный поиск. Где проходит граница — считается по бюджету, а не гадается.
 *
 * ## Почему оценки накапливаются, а не усредняются
 *
 * Главная опасность здесь не медленность, а выбор максимума из тысяч
 * зашумлённых оценок: при 150 симуляциях стандартная ошибка доли около
 * 4 п.п., и максимум по двум сотням кандидатов смещён вверх заметно сильнее,
 * чем настоящая разница между хорошей и отличной расстановкой. Поэтому
 * кандидаты не оцениваются один раз и навсегда: выжившие получают добавку
 * симуляций, счётчики складываются, и к финалу у претендентов на первое место
 * оценка на порядок точнее, чем у отсеянных.
 *
 * ## Про общие случайные числа
 *
 * Задумывались как основа дизайна, но замер их не подтвердил: разброс оценки
 * разницы упал в 1.0–1.1 раза, то есть ни во сколько. Причина в том, что два
 * разных порядка миньонов расходятся по числу случайных бросков с первого же
 * размена, и дальше потоки независимы, каким бы ни было зерно. Зерно осталось
 * ради воспроизводимости совета, а не ради точности — подробности в
 * docs/position.md.
 */

/** Оценить расстановку заданным числом симуляций. Зерно — для воспроизводимости. */
export type Evaluate = (board: readonly Minion[], sims: number, seed: number) => Estimate;

export interface Candidate {
  readonly key: string;
  readonly board: readonly Minion[];
  readonly estimate: Estimate;
  readonly score: number;
}

export interface FinalRound {
  /** Сколько кандидатов оставить в этом раунде. */
  readonly keep: number;
  /** Сколько симуляций добавить каждому оставшемуся. */
  readonly sims: number;
}

export interface SearchOptions {
  readonly objective: Objective;
  /** Симуляций на кандидата в отборочной фазе. */
  readonly screenSims: number;
  /** Потолок числа различимых расстановок, которые вообще будут оценены. */
  readonly maxCandidates: number;
  /**
   * Сколько времени отпущено на отборочную фазу.
   *
   * Потолок по числу кандидатов сам по себе не держит время: стоимость
   * симуляции зависит от размера бордов и от машины, и на большом борде те же
   * двести кандидатов считаются вдвое дольше. Советник живёт в фазе таверны,
   * где у игрока считанные секунды, поэтому ограничение честнее ставить
   * в секундах. Финальные раунды бюджетом не режутся: они дёшевы, а без них
   * первое место достаётся самому удачливому, а не лучшему.
   */
  readonly screenBudgetMs: number;
  /**
   * Сколько времени отпущено на весь совет.
   *
   * Финальные раунды не отменяются по исчерпании бюджета, а сжимаются: их
   * задача — не дать первому месту достаться самому удачливому, и совсем без
   * них ответ становится хуже, чем просто менее точным. Поэтому ограничение
   * мягкое, но соблюдается: число симуляций в раунде подбирается под то время,
   * что осталось, по фактически наблюдённой скорости.
   */
  readonly budgetMs: number;
  /** Добавочные раунды для выживших, от широкого к узкому. */
  readonly finalRounds: readonly FinalRound[];
  /** Нижняя граница симуляций в финальном раунде, ниже которой сжимать нельзя. */
  readonly minFinalSims: number;
  /** Сколько случайных расстановок подмешать к старту против локальных максимумов. */
  readonly restarts: number;
  readonly seed: number;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  objective: 'winRate',
  // 150 симуляций на кандидата — примерно оптимум точности на потраченную
  // миллисекунду. Замер: постоянная часть вызова стоит как 70 симуляций,
  // поэтому при 100 непомерно много уходит в накладные, а при 250 выигрыш
  // в точности уже не окупает удвоенного времени.
  screenSims: 150,
  maxCandidates: 200,
  // Замер: удвоение отборочного бюджета с 3 до 6 с прибавляет к качеству
  // совета около половины процентного пункта и выводит общее время за десять
  // секунд, отпущенные ТЗ. Дальше отбора выгоднее тратить время на финал.
  screenBudgetMs: 2500,
  budgetMs: 8000,
  finalRounds: [
    { keep: 6, sims: 400 },
    { keep: 3, sims: 800 },
    { keep: 3, sims: 1200 },
  ],
  minFinalSims: 100,
  // Замерено на трёх боях фикстур: со случайными перезапусками и без них
  // результат одинаков в пределах шума. Ноль оставлен потому, что бюджет
  // полезнее потратить на окрестность лучшего кандидата, а не на заведомо
  // случайные расстановки.
  restarts: 0,
  seed: 1,
};

export interface SearchReport {
  /** Лучшие расстановки, по убыванию. Первая — рекомендация. */
  readonly top: readonly Candidate[];
  /** Как борд стоит сейчас — с оценкой той же точности, что у финалистов. */
  readonly current: Candidate;
  /** Сколько различимых расстановок оценено. */
  readonly evaluated: number;
  /** Сколько всего симуляций потрачено. */
  readonly simulations: number;
  /** Пройдено ли пространство целиком. */
  readonly exhaustive: boolean;
  readonly space: { readonly size: number; readonly total: number; readonly distinct: number };
}

/** Перестановки на расстоянии одного хода. */
function* neighbours(board: readonly Minion[]): Generator<readonly Minion[]> {
  const n = board.length;

  // Обмен любой парой. Транспозиции порождают всю группу перестановок,
  // поэтому из любой расстановки достижима любая другая.
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const next = [...board];
      [next[i], next[j]] = [next[j] as Minion, next[i] as Minion];
      yield next;
    }
  }

  // Перенос миньона в начало и в конец. Обменом это не выражается: перенос
  // сдвигает всех остальных, сохраняя их относительный порядок, а в бою
  // порядок соседей решает, кого заденет клив и кто примет удар следующим.
  for (let i = 0; i < n; i += 1) {
    const rest = board.filter((_, k) => k !== i);
    const moved = board[i] as Minion;
    yield [moved, ...rest];
    yield [...rest, moved];
  }
}

function shuffled(board: readonly Minion[], random: () => number): readonly Minion[] {
  const out = [...board];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as Minion, out[i] as Minion];
  }
  return out;
}

export function searchArrangement(
  board: readonly Minion[],
  evaluate: Evaluate,
  overrides: Partial<SearchOptions> = {},
): SearchReport {
  const options: SearchOptions = { ...DEFAULT_SEARCH_OPTIONS, ...overrides };
  const space = arrangementSpace(board);
  const currentKey = space.keyOf(board);

  const pool = new Map<string, { board: readonly Minion[]; estimate: Estimate }>();
  const expanded = new Set<string>();
  let simulations = 0;
  let seedCounter = 0;

  /**
   * Досчитать кандидату симуляций.
   *
   * Каждый вызов получает своё зерно: повтор под тем же зерном дал бы тот же
   * результат, и накопление не добавило бы ни бита информации.
   */
  const measure = (candidate: readonly Minion[], sims: number): void => {
    const key = space.keyOf(candidate);
    const known = pool.get(key);
    seedCounter += 1;
    const fresh = evaluate(candidate, sims, options.seed + seedCounter);
    simulations += fresh.sims;
    pool.set(key, {
      board: known?.board ?? candidate,
      estimate: mergeEstimates(known?.estimate ?? EMPTY_ESTIMATE, fresh),
    });
  };

  const scored = (key: string): Candidate => {
    const entry = pool.get(key);
    const estimate = entry?.estimate ?? EMPTY_ESTIMATE;
    return {
      key,
      board: entry?.board ?? board,
      estimate,
      score: scoreOf(estimate, options.objective),
    };
  };

  const ranked = (): Candidate[] =>
    [...pool.keys()].map(scored).sort((a, b) => b.score - a.score);

  // ─── отбор ─────────────────────────────────────────────────────────────────
  const startedAt = Date.now();
  const deadline = startedAt + options.screenBudgetMs;
  const outOfBudget = (): boolean => pool.size >= options.maxCandidates || Date.now() > deadline;

  /**
   * Сколько симуляций на кандидата можно позволить в оставшееся время.
   *
   * Скорость не задана константой, а наблюдается: одна и та же симуляция
   * на борде из семи миньонов с десятком энчантов идёт втрое дольше, чем
   * на борде из трёх, а на чужой машине — ещё иначе. Считать по замеру,
   * сделанному однажды на своём железе, значило бы выйти за бюджет там,
   * где это важнее всего.
   */
  const affordable = (wanted: number, candidates: number): number => {
    const elapsed = Date.now() - startedAt;
    if (elapsed <= 0 || simulations === 0 || candidates === 0) return wanted;
    const simsPerMs = simulations / elapsed;
    const left = options.budgetMs - elapsed;
    const perCandidate = Math.floor((left * simsPerMs) / candidates);
    return Math.max(options.minFinalSims, Math.min(wanted, perCandidate));
  };

  measure(board, options.screenSims);

  let complete = space.distinct <= options.maxCandidates;

  if (complete) {
    for (const arrangement of space.iterate()) {
      if (arrangement.key === currentKey) continue;
      if (Date.now() > deadline) {
        // Пространство маленькое, а времени всё равно не хватило: борды
        // бывают такими, что одна симуляция идёт на порядок дольше обычной.
        // Тогда это уже не полный перебор, и говорить о нём так нельзя.
        complete = false;
        break;
      }
      measure(arrangement.board, options.screenSims);
    }
  } else {
    const random = mulberry32(options.seed);
    const starts: readonly Minion[][] = [
      [...board].reverse(),
      ...Array.from({ length: options.restarts }, () => [...shuffled(board, random)]),
    ];
    for (const start of starts) {
      if (outOfBudget()) break;
      if (!pool.has(space.keyOf(start))) measure(start, options.screenSims);
    }

    // Поиск в ширину по лучшему: разворачивается всегда самый перспективный
    // из ещё не развёрнутых, откуда бы он ни пришёл. Это позволяет вернуться
    // к отложенной ветке, если текущая упёрлась.
    while (!outOfBudget()) {
      const next = ranked().find((c) => !expanded.has(c.key));
      if (next === undefined) break;
      expanded.add(next.key);

      for (const neighbour of neighbours(next.board)) {
        if (outOfBudget()) break;
        if (pool.has(space.keyOf(neighbour))) continue;
        measure(neighbour, options.screenSims);
      }
    }
  }

  // ─── финал ─────────────────────────────────────────────────────────────────
  // Выжившим добавляются симуляции, счётчики складываются. Текущая расстановка
  // проходит все раунды принудительно: совет «оставить как есть» имеет смысл
  // только тогда, когда её оценка не грубее, чем у претендентов.
  let survivors = new Set(pool.keys());
  for (const round of options.finalRounds) {
    survivors = new Set(ranked().slice(0, round.keep).map((c) => c.key));
    survivors.add(currentKey);
    const sims = affordable(round.sims, survivors.size);
    for (const key of survivors) {
      const entry = pool.get(key);
      if (entry !== undefined) measure(entry.board, sims);
    }
  }

  // Ранжируются только те, кто прошёл все раунды. Сравнивать их с кандидатами,
  // у которых за спиной одна отборочная сотня симуляций, нельзя: при такой
  // точности наверх выйдет не лучшая расстановка, а самая удачливая — ровно
  // та ошибка, ради которой финальные раунды и заведены.
  //
  // При равных очках первой идёт текущая расстановка. Бои, где все варианты
  // равнозначны, встречаются часто, и предлагать в них перестановку ради
  // совпадения в последнем знаке — значит просить игрока о лишней работе.
  const top = [...survivors].map(scored).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.key === currentKey) return -1;
    if (b.key === currentKey) return 1;
    return 0;
  });

  return {
    top,
    current: scored(currentKey),
    evaluated: pool.size,
    simulations,
    exhaustive: complete,
    space: { size: space.size, total: space.total, distinct: space.distinct },
  };
}
