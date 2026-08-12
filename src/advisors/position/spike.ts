/**
 * Замеры под фазу 3.
 *
 *   npm run spike:position
 *
 * Четыре вопроса, которые надо было закрыть числами до того, как писать поиск:
 *
 *   1. сколько на самом деле различимых расстановок на живых бордах — 5040
 *      это верхняя граница, а не типичный случай;
 *   2. сколько стоит одна симуляция с нашими опциями прогона;
 *   3. насколько вообще расстановка меняет исход — если разброс между лучшей
 *      и худшей копеечный, весь советник не нужен;
 *   4. помогают ли общие случайные числа и не вносят ли они смещения.
 *
 * Скрипт оставлен в репозитории намеренно: числа надо перепроверять при смене
 * версии симулятора, а не доверять записанным однажды.
 */
import { readFileSync } from 'node:fs';

import { readBattleEpisodes, type BattleEpisode } from '../battle/episodes.js';
import { toBattleInfo, withPlayerBoard } from '../battle/mapper.js';
import { createBattleSimulator } from '../battle/simulator.js';
import { advisePosition } from './advisor.js';
import { arrangementSpace } from './arrangements.js';
import { withSeededRandom } from './rng.js';

const FIXTURES = ['data/fixtures/part2/game.log', 'data/fixtures/part3/game.log'] as const;

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function main(): void {
  const started = Date.now();
  const episodes: { fixture: string; episode: BattleEpisode }[] = [];
  for (const path of FIXTURES) {
    const short = path.split('/')[2] ?? path;
    for (const episode of readBattleEpisodes(readFileSync(path, 'utf8'))) {
      episodes.push({ fixture: short, episode });
    }
  }
  console.log(
    `боёв из фикстур: ${String(episodes.length)} за ${String(Date.now() - started)} мс\n`,
  );

  // ─── 1. сколько расстановок придётся считать ───────────────────────────────
  console.log('=== пространство расстановок ===');
  console.log('  фикстура  ход  миньонов   всего  различимых');
  let worstDistinct = 0;
  for (const { fixture, episode } of episodes) {
    const space = arrangementSpace(episode.playerBoard);
    worstDistinct = Math.max(worstDistinct, space.distinct);
    console.log(
      `  ${fixture.padEnd(8)} ${String(episode.turn).padStart(4)}` +
        `  ${String(space.size).padStart(8)}` +
        `  ${String(space.total).padStart(6)}` +
        `  ${String(space.distinct).padStart(11)}`,
    );
  }
  console.log(`  худший случай: ${String(worstDistinct)} различимых расстановок\n`);

  const simulator = createBattleSimulator();

  /**
   * Бой для замеров нужен спорный.
   *
   * Первый заход брал самый населённый борд — и попал на разгром 100:0, где
   * все расстановки одинаково выигрывают, а разброс тождественно ноль. Мерить
   * на таком бою шум бессмысленно: советник нужен там, где исход не предрешён.
   */
  console.log('=== выбор боя для замеров ===');
  const scored = episodes
    .filter((e) => e.episode.playerBoard.length >= 5)
    .map((e) => {
      const r = simulator.run(toBattleInfo(e.episode, 500), 500);
      return { ...e, won: r.wonPercent, contested: Math.min(r.wonPercent, 100 - r.wonPercent) };
    });
  for (const s of scored) {
    console.log(
      `  ${s.fixture} ход ${String(s.episode.turn).padStart(2)}: победа ${s.won.toFixed(1)}%`,
    );
  }
  const chosen = scored.reduce((best, e) => (e.contested > best.contested ? e : best));
  const base = toBattleInfo(chosen.episode, 1);
  console.log(
    `\nзамеры на ${chosen.fixture}, ход ${String(chosen.episode.turn)}: ` +
      `борд ${String(chosen.episode.playerBoard.length)} против ${String(chosen.episode.opponentBoard.length)}` +
      `, победа ${chosen.won.toFixed(1)}%\n`,
  );

  // ─── 2. стоимость симуляции ────────────────────────────────────────────────
  // Замеряется после прогрева и с повторами: первый заход мерил вместе с JIT
  // и завышал постоянную часть втрое.
  console.log('=== стоимость симуляции ===');
  simulator.run(base, 500);
  const timings: [number, number][] = [];
  for (const n of [1, 100, 300, 1000, 3000]) {
    const reps = n <= 300 ? 10 : 3;
    const t = process.hrtime.bigint();
    for (let i = 0; i < reps; i += 1) simulator.run(base, n);
    const ms = Number(process.hrtime.bigint() - t) / 1e6 / reps;
    timings.push([n, ms]);
    console.log(`  ${String(n).padStart(4)} симуляций: ${ms.toFixed(1)} мс`);
  }
  const [nLo, tLo] = timings[0] ?? [1, 0];
  const [nHi, tHi] = timings[timings.length - 1] ?? [1, 0];
  const perSim = (tHi - tLo) / (nHi - nLo);
  const fixed = tLo - perSim * nLo;
  console.log(
    `  на симуляцию ${(perSim * 1000).toFixed(0)} мкс, на вызов ${fixed.toFixed(1)} мс постоянных` +
      ` — это ${String(Math.round(fixed / perSim))} симуляций впустую на каждом кандидате`,
  );
  const space = arrangementSpace(chosen.episode.playerBoard);
  const cost = (candidates: number, n: number): string =>
    `${((candidates * (fixed + n * perSim)) / 1000).toFixed(1)} с`;
  console.log(`  полный перебор ${String(space.distinct)} x 300: ${cost(space.distinct, 300)}`);
  console.log(`  250 кандидатов x 300: ${cost(250, 300)}\n`);

  // ─── 3. насколько расстановка вообще решает ────────────────────────────────
  console.log('=== разброс между расстановками (N=1000, общее зерно) ===');
  const all = space.list();
  const stride = Math.max(1, Math.floor(all.length / 24));
  const sample = all.filter((_, i) => i % stride === 0).slice(0, 24);
  const winRates = sample.map((a) =>
    withSeededRandom(20260812, () => simulator.run(withPlayerBoard(base, a.board), 1000).wonPercent),
  );
  console.log(
    `  ${String(winRates.length)} расстановок: победа от ${Math.min(...winRates).toFixed(1)}%` +
      ` до ${Math.max(...winRates).toFixed(1)}%, размах ${(Math.max(...winRates) - Math.min(...winRates)).toFixed(1)} п.п.\n`,
  );

  // ─── 4. общие случайные числа ──────────────────────────────────────────────
  // Берём пару расстановок, узнаём их настоящую разницу большим прогоном,
  // а потом смотрим, насколько дрожит оценка этой разницы при N=300 с общим
  // зерном и без него.
  //
  // Пары две, и вторая важнее. Далёкая пара — лучшая против худшей — легка:
  // её и шумная оценка не перепутает. Решает поиск судьбу на близких парах,
  // где настоящая разница сопоставима с шумом, и именно там надо смотреть,
  // помогает ли общее зерно.
  const ranked = sample
    .map((a, i) => ({ a, win: winRates[i] ?? 0 }))
    .sort((x, y) => y.win - x.win);

  const closest = ranked
    .slice(1)
    .map((r, i) => ({ pair: [ranked[i], r] as const, gap: Math.abs((ranked[i]?.win ?? 0) - r.win) }))
    .reduce((best, x) => (x.gap < best.gap ? x : best));

  const pairs: { name: string; a: (typeof ranked)[number] | undefined; b: (typeof ranked)[number] | undefined }[] = [
    { name: 'далёкая пара (лучшая против худшей)', a: ranked[0], b: ranked[ranked.length - 1] },
    { name: 'близкая пара (соседи по оценке)', a: closest.pair[0], b: closest.pair[1] },
  ];

  const N = 300;
  const replicas = 30;
  console.log(`=== общие случайные числа (N=${String(N)}, ${String(replicas)} повторов) ===`);

  for (const { name, a, b } of pairs) {
    if (a === undefined || b === undefined) continue;

    const truthN = 20_000;
    const truth =
      simulator.run(withPlayerBoard(base, a.a.board), truthN).wonPercent -
      simulator.run(withPlayerBoard(base, b.a.board), truthN).wonPercent;

    const independent: number[] = [];
    const paired: number[] = [];
    for (let r = 0; r < replicas; r += 1) {
      independent.push(
        simulator.run(withPlayerBoard(base, a.a.board), N).wonPercent -
          simulator.run(withPlayerBoard(base, b.a.board), N).wonPercent,
      );
      const seed = 1000 + r;
      paired.push(
        withSeededRandom(seed, () => simulator.run(withPlayerBoard(base, a.a.board), N).wonPercent) -
          withSeededRandom(seed, () =>
            simulator.run(withPlayerBoard(base, b.a.board), N).wonPercent,
          ),
      );
    }

    // Что на самом деле нужно от оценки: правильно назвать знак разницы.
    const sign = (xs: readonly number[]): number =>
      xs.filter((x) => Math.sign(x) === Math.sign(truth) || truth === 0).length / xs.length;

    console.log(`\n  ${name}`);
    console.log(`    настоящая разница (N=${String(truthN)}): ${truth.toFixed(2)} п.п.`);
    console.log(
      `    независимые: среднее ${mean(independent).toFixed(2)}, разброс ${stdev(independent).toFixed(2)} п.п.` +
        `, знак угадан ${(sign(independent) * 100).toFixed(0)}%`,
    );
    console.log(
      `    общее зерно: среднее ${mean(paired).toFixed(2)}, разброс ${stdev(paired).toFixed(2)} п.п.` +
        `, знак угадан ${(sign(paired) * 100).toFixed(0)}%`,
    );
    console.log(
      `    разброс меньше в ${(stdev(independent) / (stdev(paired) || Number.EPSILON)).toFixed(1)} раза`,
    );
  }

  // ─── 5. поиск против полного перебора ──────────────────────────────────────
  // Единственная проверка, которая отвечает на вопрос «а находит ли он лучшее».
  // Считается только там, где перебор вообще подъёмен: 720 расстановок по 1000
  // симуляций — это полторы минуты, зато эталон настоящий, а не выведенный.
  if (space.distinct > 2000) {
    console.log(`\n=== сверка с полным перебором пропущена: ${String(space.distinct)} расстановок ===`);
    return;
  }

  console.log(`\n=== поиск против полного перебора (${String(space.distinct)} расстановок x 1000) ===`);
  const truthStarted = Date.now();
  const table = new Map<string, number>();
  for (const arrangement of space.iterate()) {
    table.set(
      arrangement.key,
      simulator.run(withPlayerBoard(base, arrangement.board), 1000).wonPercent,
    );
  }
  const sortedTruth = [...table.values()].sort((x, y) => y - x);
  const bestTruth = sortedTruth[0] ?? 0;
  console.log(
    `  эталон за ${((Date.now() - truthStarted) / 1000).toFixed(0)} с:` +
      ` лучшая ${bestTruth.toFixed(1)}%, худшая ${(sortedTruth[sortedTruth.length - 1] ?? 0).toFixed(1)}%,` +
      ` медиана ${(sortedTruth[Math.floor(sortedTruth.length / 2)] ?? 0).toFixed(1)}%`,
  );

  const searchStarted = Date.now();
  const advice = advisePosition(chosen.episode, { simulator });
  const searchMs = Date.now() - searchStarted;
  const recommended = advice.top[0];
  if (recommended === undefined) return;

  const truthOfPick = table.get(recommended.key) ?? 0;
  const truthOfCurrent = table.get(space.keyOf(chosen.episode.playerBoard)) ?? 0;
  const betterThanPick = sortedTruth.filter((v) => v > truthOfPick).length;

  console.log(`  поиск за ${(searchMs / 1000).toFixed(1)} с, оценено ${String(advice.report.evaluated)} расстановок`);
  console.log(
    `  рекомендация: по эталону ${truthOfPick.toFixed(1)}%` +
      ` — отставание от лучшей ${(bestTruth - truthOfPick).toFixed(1)} п.п.,` +
      ` выше неё только ${String(betterThanPick)} из ${String(sortedTruth.length)}`,
  );
  console.log(
    `  как стояло: по эталону ${truthOfCurrent.toFixed(1)}%` +
      ` — выигрыш от перестановки ${(truthOfPick - truthOfCurrent).toFixed(1)} п.п.`,
  );
}

main();
