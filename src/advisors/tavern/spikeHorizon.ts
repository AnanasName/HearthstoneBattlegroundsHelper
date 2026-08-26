/**
 * Замер: сколько ходов таверны остаётся впереди на каждом ходу партии.
 *
 *   npm run spike:horizon
 *
 * ## Зачем
 *
 * Есть эффекты, которые платят не разово, а КАЖДЫЙ ход: предел золота
 * («Increase your maximum Gold by 1» — ветвь Snare Trapper из part28,
 * заклинания витрины Strike Oil). Чтобы сравнить такой эффект с телом
 * или с разовой монетой, надо знать, сколько ходов он ещё будет платить, —
 * то есть сколько партии осталось. Числа этого замера и лежат в таблице
 * `rules.remainingTavernTurns`.
 *
 * Источник — НАШ датасет (`data/dataset/`), а не фикстуры: партий там
 * больше, и это партии того же игрока, для которого советник и пишется.
 * Дедуп по отпечатку и фильтр билда — общие с фазой 6 (`src/ml/dataset.ts`),
 * иначе одна партия, записанная и живым режимом, и досбором, считалась бы
 * дважды.
 *
 * ## Чего замер НЕ говорит
 *
 * Он не предсказывает конкретную партию. Здоровье в таблицу не входит,
 * хотя связь очевидна: сюда оно не берётся не по забывчивости, а потому
 * что с ходом оно смешано (низкое hp бывает в основном поздно), и на
 * двухфакторную таблицу двух с половиной десятков партий не хватает.
 * Замер печатает hp-разрез отдельно, чтобы эта связь была видна числом.
 *
 * На part28 цена допущения видна прямо: на 7-м ходу таверны таблица обещает
 * 5.3 хода, а игрок прожил 2. Совет обязан называть число вслух — тогда
 * игрок может возразить, а не гадать, откуда взялась ветвь.
 */
import { tavernTurnOf } from './rules.js';
import { loadDataset } from '../../ml/dataset.js';

interface Point {
  readonly tavernTurn: number;
  readonly hp: number;
  /** Сколько ходов таверны в этой партии было ПОСЛЕ этой точки. */
  readonly remaining: number;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const lo = s[Math.floor((s.length - 1) / 2)] ?? 0;
  const hi = s[Math.ceil((s.length - 1) / 2)] ?? 0;
  return (lo + hi) / 2;
}

export function collectPoints(): { readonly points: Point[]; readonly lengths: number[] } {
  const ds = loadDataset();
  const points: Point[] = [];
  const lengths: number[] = [];

  for (const game of ds.games) {
    const checkpoints = game.record.checkpoints;
    if (checkpoints.length === 0) continue;
    const turns = checkpoints.map((c) => tavernTurnOf(c.turn));
    const last = Math.max(...turns);
    lengths.push(last);

    for (const [i, checkpoint] of checkpoints.entries()) {
      const hero = (checkpoint.state as { hero?: { health?: number; armor?: number } }).hero;
      points.push({
        tavernTurn: turns[i] ?? 0,
        hp: (hero?.health ?? 0) + (hero?.armor ?? 0),
        remaining: last - (turns[i] ?? 0),
      });
    }
  }
  return { points, lengths };
}

function main(): void {
  const { points, lengths } = collectPoints();
  if (points.length === 0) {
    console.log('датасет пуст — замерять нечего (data/dataset/)');
    return;
  }

  console.log(`партий: ${String(lengths.length)}, точек решения: ${String(points.length)}`);
  console.log(`длина партии в ходах таверны: ${[...lengths].sort((a, b) => a - b).join(' ')}`);
  console.log(`  среднее ${mean(lengths).toFixed(1)}, медиана ${median(lengths).toFixed(1)}`);

  console.log('\nход таверны | точек | остаётся ходов: среднее / медиана');
  const table: number[] = [];
  for (let turn = 1; turn <= 20; turn++) {
    const rest = points.filter((p) => p.tavernTurn === turn).map((p) => p.remaining);
    if (rest.length === 0) continue;
    table[turn - 1] = Number(mean(rest).toFixed(1));
    console.log(
      `${String(turn).padStart(11)} | ${String(rest.length).padStart(5)} | ` +
        `${mean(rest).toFixed(2).padStart(7)} / ${median(rest).toFixed(1)}`,
    );
  }
  console.log(`\nтаблица для rules.remainingTavernTurns: [${table.join(', ')}]`);

  console.log('\nразрез по здоровью (все ходы) — связь есть, в таблицу не входит:');
  for (const [lo, hi] of [
    [1, 10],
    [11, 20],
    [21, 30],
    [31, 99],
  ] as const) {
    const rest = points.filter((p) => p.hp >= lo && p.hp <= hi).map((p) => p.remaining);
    if (rest.length === 0) continue;
    console.log(
      `  hp ${String(lo)}–${String(hi)}: точек ${String(rest.length).padStart(3)}, ` +
        `остаётся ${mean(rest).toFixed(2)} / ${median(rest).toFixed(1)}`,
    );
  }
}

main();
