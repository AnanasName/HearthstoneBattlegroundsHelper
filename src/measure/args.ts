/**
 * Аргументы замеров — одинаковые у всех скриптов батареи.
 *
 *   --seed=7          зерно симулятора (по умолчанию 1)
 *   --parts=4,5,30-35 подмножество партий (по умолчанию весь список)
 *
 * Подмножество нужно не для отчёта, а для проверки на ходу: «видит ли
 * сверка правку» на трёх партиях отвечается за минуту, а не за полчаса.
 * Итоговые числа снимаются только на полном списке.
 */

export const DEFAULT_SEED = 1;

function value(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

export function seedArg(argv: readonly string[]): number {
  const raw = value(argv, 'seed');
  if (raw === null) return DEFAULT_SEED;
  const seed = Number(raw);
  if (!Number.isInteger(seed)) throw new Error(`--seed ждёт целое число, а получил «${raw}»`);
  return seed;
}

/** Партии из `--parts`, в порядке общего списка; чужих номеров не добавляет. */
export function partsArg(argv: readonly string[], all: readonly number[]): readonly number[] {
  const raw = value(argv, 'parts');
  if (raw === null) return all;
  const wanted = new Set<number>();
  for (const chunk of raw.split(',')) {
    const range = /^(\d+)-(\d+)$/.exec(chunk.trim());
    if (range !== null) {
      for (let n = Number(range[1]); n <= Number(range[2]); n++) wanted.add(n);
    } else if (/^\d+$/.test(chunk.trim())) {
      wanted.add(Number(chunk.trim()));
    } else {
      throw new Error(`--parts ждёт номера и диапазоны через запятую, а получил «${chunk}»`);
    }
  }
  return all.filter((n) => wanted.has(n));
}

/** Аргументы без `--`: пути, которые скрипт принимает позиционно. */
export function positionalArgs(argv: readonly string[]): readonly string[] {
  return argv.filter((a) => !a.startsWith('--'));
}
