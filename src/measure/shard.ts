/**
 * Замер, разрезанный на куски по партиям.
 *
 * Зачем. Одновременность по замерам упирается в их число: замеров три,
 * ядер шестнадцать. Настоящая ось разбиения — партии: `validate:spend`
 * гоняет `for (const part of FIXTURES)` по 52 партиям в один поток, и это
 * 3030 с из 6038 всего прогона.
 *
 * Почему куски дают ТЕ ЖЕ числа. Партии независимы: каждая читает свой лог
 * и складывает строки сравнения в общие массивы, а зерно симулятора берётся
 * от содержимого боя, а не от номера вызова (D134). Поэтому строки, собранные
 * по кускам и склеенные в порядке партий, совпадают со строками прогона
 * подряд — не «в среднем», а поэлементно.
 *
 * Почему склейка идёт СТРОКАМИ, а не метриками. Метрика — это доля или
 * среднее, у партий разный вес, и складывать их пришлось бы с весами,
 * объявленными руками для каждой из 37 метрик. Ошибка в одном весе тихо
 * испортила бы прибор, которым мерится всё остальное. Куски везут сырые
 * строки, а метрики считает тот же код в конце, что и при прогоне подряд.
 *
 * Отсюда два режима у скрипта замера:
 *   --shard-out=<файл>   посчитать свои партии и сложить строки в файл
 *   --shard-in=<каталог> прочитать все куски, склеить и напечатать итог
 * Режим склейки не грузит ни карт, ни симулятора: метрики — это числа
 * над числами.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function value(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

/** Файл, куда кусок складывает свои строки; `null` — обычный прогон. */
export function shardOutArg(argv: readonly string[]): string | null {
  return value(argv, 'shard-out');
}

/** Каталог с кусками для склейки; `null` — обычный прогон. */
export function shardInArg(argv: readonly string[]): string | null {
  return value(argv, 'shard-in');
}

/**
 * Имя файла куска по его номеру.
 *
 * Номер дополняется нулями, потому что куски читаются отсортированными
 * по имени: без этого `10.json` встал бы перед `2.json`, и строки склеились
 * бы не в порядке партий.
 */
export function shardName(index: number): string {
  return `${String(index).padStart(4, '0')}.json`;
}

export function writeShard<T>(path: string, data: T): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

/** Куски каталога в порядке номеров. Посторонние файлы пропускаются. */
export function readShards<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as T);
}
