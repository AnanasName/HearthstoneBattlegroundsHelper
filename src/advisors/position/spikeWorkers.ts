/**
 * Замер: даёт ли несколько независимых поисков лучший совет, чем один.
 *
 *   npm run spike:workers
 *   npm run spike:workers -- --parts=17,30 --searches=8 --boards=4
 *
 * Вопрос, ради которого всё. Поиск расстановки перебирает не всё: на борде
 * из семи миньонов 5040 расстановок, а в отборочный бюджет влезает две сотни
 * кандидатов. Какие именно — решает поиск в ширину по лучшему, а «лучший»
 * он выбирает по зашумлённой оценке, поэтому разные зёрна ходят разными
 * путями. Восемь ядер позволяют пройти восемь путей за то же время. Вопрос
 * в том, становится ли совет от этого ЛУЧШЕ, — и на сколько.
 *
 * ## Почему это меряется в ОДНОМ процессе
 *
 * Здесь меряется качество совета, а не время. Восемь поисков гоняются друг
 * за другом, а вывод делается такой, как если бы они шли одновременно:
 * на восьми ядрах это то же самое за те же секунды. Пул воркеров строить
 * до этого замера незачем — если выигрыша нет, строить нечего.
 *
 * ## Эталон
 *
 * Полный перебор расстановок в два прохода, как в самом поиске: сперва все
 * с умеренным числом симуляций, потом лучшие — с большим. Одного прохода
 * мало: «истинно лучшая» по шумному перебору сама оказалась бы самой
 * удачливой, и замер сравнивал бы один шум с другим.
 */
import { readFileSync } from 'node:fs';

import { readBattleEpisodes, type BattleEpisode } from '../battle/episodes.js';
import { toBattleInfo, withPlayerBoard } from '../battle/mapper.js';
import { createBattleSimulator } from '../battle/simulator.js';
import { partsArg } from '../../measure/args.js';
import { fixtureLogPaths } from '../../data/fixtureGames.js';
import { advisePosition } from './advisor.js';
import { arrangementSpace } from './arrangements.js';
import { chooseAdvice } from './merge.js';
import { DEFAULT_SEARCH_OPTIONS } from './search.js';
import { withSeededRandom } from './rng.js';
import {
  EMPTY_ESTIMATE,
  mergeEstimates,
  toEstimate,
  OBJECTIVES,
  type Estimate,
} from './score.js';
import type { Minion } from '../../state/types.js';

/** Сколько симуляций на расстановку в первом проходе эталона. */
const TRUTH_SCREEN = 300;
/** Сколько добавить лучшим из первого прохода. */
const TRUTH_FINAL = 3000;
/** Скольким лучшим добавлять. */
const TRUTH_KEEP = 12;
/**
 * Размер борда по умолчанию.
 *
 * Шесть — это 720 расстановок, из которых поиск смотрит две сотни. Семь —
 * 5040, и поиск видит 4 % пространства: там польза от нескольких путей
 * должна быть больше всего, но и эталон дороже на порядок. Меняется
 * флагом `--size`.
 */
const DEFAULT_BOARD = 6;

/**
 * На сколько стандартных ошибок уценивается оценка во втором способе выбора.
 *
 * Единица — привычная «одна сигма»: расстановка со ста симуляциями теряет
 * около 5 п.п., с восемьюстами — около 1.7. Число подобрано не замером,
 * а смыслом; если способ окажется полезным, его и надо будет подбирать.
 */
const LCB_Z = 1;

/**
 * Бюджет по часам снимается у ВСЕХ сравниваемых способов.
 *
 * Иначе замер меряет не способ, а загрузку машины. Проверено дорого: три
 * прогона по одним и тем же бордам с одним и тем же зерном дали у одного
 * поиска 0.21, 0.26 и 0.55 п.п. отставания — разброс больше, чем все
 * различия между способами. Причина в строке «кандидатов»: под нагрузкой
 * поиск успевал просмотреть 93 расстановки вместо двух сотен, потому что
 * отборочная фаза режется миллисекундами (`screenBudgetMs`).
 *
 * Со снятым бюджетом вход определяет ответ целиком (об этом прямо сказано
 * в `advisor.ts`), и сравнение идёт при равной РАБОТЕ: столько-то кандидатов,
 * столько-то симуляций. Это и есть честная модель «что купят восемь ядер» —
 * они покупают работу, а не часы.
 */
const NO_BUDGET = { screenBudgetMs: 3_600_000, budgetMs: 3_600_000 };

function flag(name: string, fallback: number): number {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (found === undefined) return fallback;
  const value = Number(found.slice(name.length + 3));
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} ждёт целое от единицы`);
  return value;
}

interface Case {
  readonly part: number;
  readonly turn: number;
  readonly episode: BattleEpisode;
}

/** Бои с бордом подходящего размера: на мелких переборе и так полный. */
function casesFrom(part: number, wanted: number, size: number): Case[] {
  const found: Case[] = [];
  for (const path of fixtureLogPaths(part)) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const episode of readBattleEpisodes(text)) {
      // Пять миньонов и меньше — поиск перебирает целиком, и спорить не о чем.
      if (episode.playerBoard.length !== size) continue;
      found.push({ part, turn: episode.turn, episode });
      if (found.length >= wanted) return found;
    }
  }
  return found;
}

function main(): void {
  const parts = partsArg(process.argv, [17, 30, 41]);
  const searches = flag('searches', 8);
  const perPart = flag('boards', 2);
  const size = flag('size', DEFAULT_BOARD);
  const simulator = createBattleSimulator();
  const objective = 'winRate';
  const value = (e: Estimate): number => OBJECTIVES[objective](e);

  const cases = parts.flatMap((p) => casesFrom(p, perPart, size));
  console.log(
    `бордов по ${String(size)} миньонов: ${String(cases.length)},` +
      ` поисков на борд: ${String(searches)}, эталон ${String(TRUTH_SCREEN)}+${String(TRUTH_FINAL)}`,
  );
  if (cases.length === 0) {
    console.log('подходящих боёв не нашлось — возьмите другие партии');
    return;
  }

  const singleGaps: number[] = [];
  const pooledGaps: number[] = [];
  const lcbGaps: number[] = [];
  const richGaps: number[] = [];
  let singleBest = 0;
  let pooledBest = 0;
  let lcbBest = 0;
  let changed = 0;

  for (const { part, turn, episode } of cases) {
    const board = episode.playerBoard;
    const base = toBattleInfo(episode, 1);
    const space = arrangementSpace(board);

    // ─── эталон, проход первый ───────────────────────────────────────────────
    const started = Date.now();
    const truth = new Map<string, Estimate>();
    const boards = new Map<string, readonly Minion[]>();
    for (const arrangement of space.iterate()) {
      const e = toEstimate(
        withSeededRandom(
          90_000 + truth.size,
          () => simulator.run(withPlayerBoard(base, arrangement.board), TRUTH_SCREEN),
        ),
      );
      truth.set(arrangement.key, e);
      boards.set(arrangement.key, arrangement.board);
    }

    // ─── эталон, проход второй: лучшим добавляется точность ──────────────────
    const shortlist = [...truth.entries()]
      .sort((a, b) => value(b[1]) - value(a[1]))
      .slice(0, TRUTH_KEEP)
      .map(([key]) => key);
    for (const key of shortlist) {
      const arrangement = boards.get(key);
      if (arrangement === undefined) continue;
      const extra = toEstimate(
        withSeededRandom(
          70_000 + shortlist.indexOf(key),
          () => simulator.run(withPlayerBoard(base, arrangement), TRUTH_FINAL),
        ),
      );
      truth.set(key, mergeEstimates(truth.get(key) ?? EMPTY_ESTIMATE, extra));
    }

    const ranked = [...truth.entries()].sort((a, b) => value(b[1]) - value(a[1]));
    const bestKey = ranked[0]?.[0] ?? '';
    const bestValue = value(ranked[0]?.[1] ?? EMPTY_ESTIMATE);
    const truthMs = Date.now() - started;

    // ─── советы ──────────────────────────────────────────────────────────────
    // Эпизод боя — это уже готовый сетап: тот же тип принимает `toBattleInfo`.
    const advices = Array.from({ length: searches }, (_, i) =>
      advisePosition(episode, { simulator }, { ...NO_BUDGET, seed: i + 1 }),
    );

    // Третий способ распорядиться теми же ядрами: не несколько поисков,
    // а ОДИН с бюджетом во столько же раз больше. Если выигрыш есть здесь,
    // а не в нескольких поисках, то и строить надо другое — разбиение
    // счёта внутри одного поиска, а не пул независимых.
    const rich = advisePosition(
      episode,
      { simulator },
      {
        ...NO_BUDGET,
        seed: 1,
        // Восемь ядер покупают восьмикратную РАБОТУ: столько же раз больше
        // кандидатов в отборе и столько же раз больше симуляций финалистам.
        maxCandidates: DEFAULT_SEARCH_OPTIONS.maxCandidates * searches,
        finalRounds: DEFAULT_SEARCH_OPTIONS.finalRounds.map((r) => ({
          keep: r.keep,
          sims: r.sims * searches,
        })),
      },
    );

    const single = advices[0]?.top[0]?.key ?? '';
    const pooled = chooseAdvice(advices, objective)?.key ?? '';
    // Тот же выбор, но с уценкой на неуверенность: расстановка, за которой
    // мало симуляций, должна победить разницей, а не везением.
    const lcb = chooseAdvice(advices, objective, { z: LCB_Z })?.key ?? '';

    const gapOf = (key: string): number =>
      (bestValue - value(truth.get(key) ?? EMPTY_ESTIMATE)) * 100;

    const singleGap = gapOf(single);
    const pooledGap = gapOf(pooled);
    const lcbGap = gapOf(lcb);
    const richGap = gapOf(rich.top[0]?.key ?? '');
    singleGaps.push(singleGap);
    pooledGaps.push(pooledGap);
    lcbGaps.push(lcbGap);
    richGaps.push(richGap);
    if (single === bestKey) singleBest += 1;
    if (pooled === bestKey) pooledBest += 1;
    if (lcb === bestKey) lcbBest += 1;
    if (single !== pooled) changed += 1;

    console.log(
      `\npart${String(part)} ход ${String(turn)}: расстановок ${String(space.distinct)},` +
        ` эталон за ${(truthMs / 1000).toFixed(0)} с, лучшая ${(bestValue * 100).toFixed(1)} %`,
    );
    console.log(
      `  один поиск:   отставание ${singleGap.toFixed(2)} п.п.${single === bestKey ? ' (попал в лучшую)' : ''}`,
    );
    console.log(
      `  ${String(searches)} поисков:   отставание ${pooledGap.toFixed(2)} п.п.` +
        `${pooled === bestKey ? ' (попал в лучшую)' : ''}${single === pooled ? ' — тот же совет' : ' — СОВЕТ ДРУГОЙ'}`,
    );
    console.log(
      `  то же, с уценкой: отставание ${lcbGap.toFixed(2)} п.п.` +
        `${lcb === bestKey ? ' (попал в лучшую)' : ''}${lcb === single ? ' — как один поиск' : ''}`,
    );
    console.log(
      `  один x${String(searches)} бюджет: отставание ${richGap.toFixed(2)} п.п.` +
        `${rich.top[0]?.key === bestKey ? ' (попал в лучшую)' : ''}` +
        `, кандидатов ${String(rich.report.evaluated)} против ${String(advices[0]?.report.evaluated ?? 0)}`,
    );
  }

  const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log('\n═══ итог ═══');
  console.log(`  бордов:                      ${String(cases.length)}`);
  console.log(`  совет изменился на:          ${String(changed)}`);
  console.log(
    `  попаданий в лучшую: один ${String(singleBest)},` +
      ` ${String(searches)} поисков ${String(pooledBest)}, с уценкой ${String(lcbBest)}`,
  );
  console.log(`  среднее отставание, один поиск:        ${mean(singleGaps).toFixed(2)} п.п.`);
  console.log(`  среднее отставание, ${String(searches)} поисков:        ${mean(pooledGaps).toFixed(2)} п.п.`);
  console.log(`  среднее отставание, ${String(searches)} с уценкой:      ${mean(lcbGaps).toFixed(2)} п.п.`);
  console.log(`  среднее отставание, один x${String(searches)} бюджет:  ${mean(richGaps).toFixed(2)} п.п.`);
  console.log(
    `\n  выигрыш против одного поиска (больше нуля — лучше):` +
      `\n    ${String(searches)} поисков:        ${(mean(singleGaps) - mean(pooledGaps)).toFixed(2)} п.п.` +
      `\n    ${String(searches)} с уценкой:      ${(mean(singleGaps) - mean(lcbGaps)).toFixed(2)} п.п.` +
      `\n    один x${String(searches)} бюджет:   ${(mean(singleGaps) - mean(richGaps)).toFixed(2)} п.п.`,
  );
}

main();
