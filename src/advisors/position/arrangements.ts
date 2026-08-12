import type { Minion } from '../../state/types.js';

/**
 * Пространство расстановок борда.
 *
 * Расстановка — это перестановка тех же самых миньонов: позиция слева направо
 * задаётся порядком в массиве, и больше ничем. Верхняя граница 7! = 5040,
 * но фактических вариантов почти всегда меньше: два одинаковых миньона
 * взаимозаменяемы, и менять их местами — не другая расстановка, а та же самая.
 * Тройка одинаковых токенов режет перебор в шесть раз, и это самый дешёвый
 * способ сократить работу, не потеряв ни одного настоящего кандидата.
 */

/**
 * Всё, чем миньоны могут отличаться друг от друга для симулятора.
 *
 * Сознательно НЕ входят:
 *  - `entityId` и `zonePos` — они у любых двух миньонов разные по определению,
 *    и с ними склеиться не смогло бы ничто;
 *  - `entityId` и `timing` энчантов — те тоже уникальны, а на бой влияет
 *    содержимое энчанта, не номер, под которым его создали.
 *
 * Всё остальное входит целиком, включая сырые теги. Направление ошибки выбрано
 * осознанно: лишний класс — это лишние кандидаты и чуть больше работы,
 * а ошибочно склеенные миньоны — молча неверный совет.
 */
/**
 * Кэш сигнатур.
 *
 * Поиск считает ключ расстановки на каждого соседа: две сотни кандидатов
 * по три десятка соседей — это десятки тысяч сигнатур за один совет, а внутри
 * каждой JSON от объекта тегов. Миньоны при этом одни и те же объекты:
 * расстановка меняет их порядок, а не содержимое.
 */
const signatureCache = new WeakMap<Minion, string>();

export function minionSignature(m: Minion): string {
  const cached = signatureCache.get(m);
  if (cached !== undefined) return cached;
  const computed = computeSignature(m);
  signatureCache.set(m, computed);
  return computed;
}

function computeSignature(m: Minion): string {
  return JSON.stringify([
    m.cardId,
    m.attack,
    m.health,
    m.maxHealth,
    m.techLevel,
    m.taunt,
    m.divineShield,
    m.poisonous,
    m.venomous,
    m.reborn,
    m.windfury,
    m.stealth,
    m.golden,
    m.scriptData,
    // Порядок энчантов на носителе задан временем наложения и для сравнения
    // двух разных миньонов ничего не значит — сравнивается набор.
    m.enchantments
      .map((e) => `${e.cardId}:${String(e.scriptDataNum1)}:${String(e.scriptDataNum2)}`)
      .sort(),
    Object.entries(m.tags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);
}

export interface Arrangement {
  /** Борд в этом порядке, слева направо. */
  readonly board: readonly Minion[];
  /** Канонический ключ: равные ключи — неразличимые для симулятора расстановки. */
  readonly key: string;
}

export interface ArrangementSpace {
  /** Сколько миньонов на борду. */
  readonly size: number;
  /** Сколько всего перестановок, n!. */
  readonly total: number;
  /** Сколько из них различимы — то, что реально придётся считать. */
  readonly distinct: number;
  /** Ключ произвольной перестановки того же борда. */
  readonly keyOf: (board: readonly Minion[]) => string;
  /** Все различимые расстановки по очереди. */
  readonly iterate: () => Generator<Arrangement>;
  /** Они же списком. Для 7 миньонов это максимум 5040 элементов. */
  readonly list: () => Arrangement[];
}

function factorial(n: number): number {
  let out = 1;
  for (let i = 2; i <= n; i += 1) out *= i;
  return out;
}

export function arrangementSpace(board: readonly Minion[]): ArrangementSpace {
  // Класс — группа неразличимых миньонов. Нумеруются по первому появлению,
  // так что у исходного борда ключ получается вида "0,1,2,…".
  const classOfSignature = new Map<string, number>();
  const membersByClass: Minion[][] = [];

  for (const minion of board) {
    const signature = minionSignature(minion);
    let cls = classOfSignature.get(signature);
    if (cls === undefined) {
      cls = membersByClass.length;
      classOfSignature.set(signature, cls);
      membersByClass.push([]);
    }
    (membersByClass[cls] ?? []).push(minion);
  }

  const counts = membersByClass.map((m) => m.length);
  const distinct = counts.reduce((acc, k) => acc / factorial(k), factorial(board.length));

  const keyOf = (other: readonly Minion[]): string =>
    other
      .map((m) => {
        const cls = classOfSignature.get(minionSignature(m));
        // Чужой миньон в ключе того же борда — ошибка вызова, но ключ обязан
        // остаться различающим, иначе поиск молча схлопнет разные варианты.
        return cls === undefined ? minionSignature(m) : String(cls);
      })
      .join(',');

  function* permutations(): Generator<Arrangement> {
    const remaining = [...counts];
    const order: number[] = [];

    function* step(): Generator<Arrangement> {
      if (order.length === board.length) {
        // Внутри класса миньоны взаимозаменяемы, поэтому берутся по порядку.
        const taken = counts.map(() => 0);
        const arranged = order.map((cls) => {
          const index = taken[cls] ?? 0;
          taken[cls] = index + 1;
          return (membersByClass[cls] ?? [])[index] as Minion;
        });
        yield { board: arranged, key: order.join(',') };
        return;
      }
      for (let cls = 0; cls < remaining.length; cls += 1) {
        if ((remaining[cls] ?? 0) === 0) continue;
        remaining[cls] = (remaining[cls] ?? 0) - 1;
        order.push(cls);
        yield* step();
        order.pop();
        remaining[cls] = (remaining[cls] ?? 0) + 1;
      }
    }

    yield* step();
  }

  return {
    size: board.length,
    total: factorial(board.length),
    distinct,
    keyOf,
    iterate: permutations,
    list: () => [...permutations()],
  };
}
