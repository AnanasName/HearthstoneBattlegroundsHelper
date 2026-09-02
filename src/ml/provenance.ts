/**
 * Чья это партия и с подсказками ли сыграна — отбор и счёт по людям.
 *
 * ## Зачем
 *
 * До 02.09.2026 читатели датасета (`ml:eval`, `ml:imitation`, `ml:track`,
 * `spike:horizon`) не различали своих партий и чужих вовсе: слов
 * `contributor` и `overlay` в `src/ml/` не было ни одного. Пока датасет
 * состоял из партий одного человека, это ничему не мешало. С приёмом
 * архивов от исполнителей (docs/collector.md) молчаливое смешение стало бы
 * тихо неверным числом сразу в двух местах:
 *
 *  - **имитация покупок меняет СМЫСЛ.** На своих партиях она меряет «чей
 *    выбор ближе к лучшему по бою — игрока или советника». На чужих тем же
 *    счётом получается УРОВЕНЬ ИСПОЛНИТЕЛЯ, а не качество советника,
 *    и без рейтинга эти две величины не разделить. Среднее по нескольким
 *    людям — среднее по разным вопросам, то есть ничто;
 *  - **партия по подсказкам — не «как играют люди»** (второй контур петли,
 *    docs/ml.md). Флаг `overlay` для того и пишется в каждую сессию.
 *
 * ## Решения, принятые здесь
 *
 * **Умолчание — СВОИ партии.** Все записанные в docs числа замеров
 * посчитаны на своих партиях; если бы умолчанием стало «все», первый же
 * принятый архив молча сдвинул бы их, и перезамер сравнивал бы разное.
 * Чужие партии берутся явным флагом — `--games=contributors` или `all`.
 *
 * **Отсутствие поля значит «своя», а не «неизвестно».** Так же читается
 * `actions` до 19.08: у собственных записей поля `contributor` нет вовсе,
 * его ставит только `dataset:import`. А вот `overlay` у своих записей
 * действительно неизвестен (живой рекордер его не писал), и это разные
 * вещи: `null` здесь — «не сказано», и фильтр по оверлею такие записи
 * не пропускает ни в `on`, ни в `off`.
 *
 * **Счёт по людям печатается ВСЕГДА**, даже когда исполнителей нет:
 * строка «свои 32, исполнителей 0» стоит дёшево, а её отсутствие однажды
 * скроет, что половина выборки — чужая.
 */
import type { DatasetGame } from './dataset.js';

/** Кого берём в выборку. */
export type WhoFilter = 'own' | 'contributors' | 'all';

/** Что требуем от флага оверлея. `any` — не спрашивать. */
export type OverlayFilter = 'any' | 'on' | 'off';

export interface DatasetFilter {
  readonly who: WhoFilter;
  readonly overlay: OverlayFilter;
}

export const DEFAULT_FILTER: DatasetFilter = { who: 'own', overlay: 'any' };

/** Псевдоним исполнителя или `null`, если партия своя. */
export function contributorOf(game: DatasetGame): string | null {
  const name = game.record.contributor;
  return name === undefined || name === '' ? null : name;
}

/**
 * Шёл ли оверлей: `null` — не сказано. У своих записей до появления флага
 * его нет, и выдавать это за «нет» нельзя: партии-то как раз по подсказкам.
 */
export function overlayOf(game: DatasetGame): boolean | null {
  return game.record.overlay ?? null;
}

export function matchesFilter(game: DatasetGame, filter: DatasetFilter): boolean {
  const contributor = contributorOf(game);
  if (filter.who === 'own' && contributor !== null) return false;
  if (filter.who === 'contributors' && contributor === null) return false;
  if (filter.overlay !== 'any' && overlayOf(game) !== (filter.overlay === 'on')) return false;
  return true;
}

export function filterGames(
  games: readonly DatasetGame[],
  filter: DatasetFilter,
): readonly DatasetGame[] {
  return games.filter((g) => matchesFilter(g, filter));
}

/** Одна строка счёта по людям. */
export interface ProvenanceRow {
  /** Псевдоним исполнителя или `null` — свои партии. */
  readonly contributor: string | null;
  readonly games: number;
  /** Рейтинг СО СЛОВ, если назван; у своих партий его нет. */
  readonly rating: number | null;
  readonly withOverlay: number;
  readonly withoutOverlay: number;
  readonly overlayUnknown: number;
}

/** Счёт по людям: свои первыми, дальше исполнители по числу партий. */
export function provenanceRows(games: readonly DatasetGame[]): readonly ProvenanceRow[] {
  const byPerson = new Map<string | null, DatasetGame[]>();
  for (const game of games) {
    const key = contributorOf(game);
    const list = byPerson.get(key);
    if (list === undefined) byPerson.set(key, [game]);
    else list.push(game);
  }

  const rows = [...byPerson.entries()].map(([contributor, list]) => {
    const overlay = list.map(overlayOf);
    return {
      contributor,
      games: list.length,
      // Рейтинг называет сам исполнитель, и у разных его партий он может
      // разойтись; берём последний названный — он свежее.
      rating: list.reduce<number | null>((r, g) => g.record.contributorRating ?? r, null),
      withOverlay: overlay.filter((o) => o === true).length,
      withoutOverlay: overlay.filter((o) => o === false).length,
      overlayUnknown: overlay.filter((o) => o === null).length,
    };
  });

  return rows.sort((a, b) => {
    if (a.contributor === null) return -1;
    if (b.contributor === null) return 1;
    return b.games - a.games || a.contributor.localeCompare(b.contributor);
  });
}

/**
 * Разбор флагов командной строки: `--games=own|contributors|all`
 * и `--overlay=any|on|off`. Неизвестное значение — ошибка, а не молчаливое
 * умолчание: замер, посчитанный не на той выборке, ничем себя не выдаёт.
 */
export function parseDatasetFilter(argv: readonly string[]): DatasetFilter {
  const value = (name: string): string | null => {
    const arg = argv.find((a) => a.startsWith(`--${name}=`));
    return arg === undefined ? null : arg.slice(name.length + 3);
  };

  const who = value('games');
  const overlay = value('overlay');
  if (who !== null && who !== 'own' && who !== 'contributors' && who !== 'all') {
    throw new Error(`неизвестная выборка партий: ${who} (own | contributors | all)`);
  }
  if (overlay !== null && overlay !== 'any' && overlay !== 'on' && overlay !== 'off') {
    throw new Error(`неизвестный фильтр оверлея: ${overlay} (any | on | off)`);
  }
  return {
    who: who ?? DEFAULT_FILTER.who,
    overlay: overlay ?? DEFAULT_FILTER.overlay,
  };
}

/** Человекочитаемый счёт по людям плюс что отсеял фильтр. */
export function formatProvenance(
  all: readonly DatasetGame[],
  filter: DatasetFilter,
): readonly string[] {
  const lines: string[] = [];
  const rows = provenanceRows(all);
  const own = rows.find((r) => r.contributor === null)?.games ?? 0;
  const contributors = rows.filter((r) => r.contributor !== null);
  const theirGames = contributors.reduce((n, r) => n + r.games, 0);
  lines.push(
    `в датасете: своих партий ${String(own)}, ` +
      `от исполнителей ${String(theirGames)} (людей ${String(contributors.length)})`,
  );
  for (const row of contributors) {
    lines.push(
      `  ${String(row.contributor)}: партий ${String(row.games)}` +
        `, рейтинг ${row.rating === null ? 'не назван' : String(row.rating)}` +
        `, с оверлеем ${String(row.withOverlay)}` +
        `, без ${String(row.withoutOverlay)}` +
        `, не сказано ${String(row.overlayUnknown)}`,
    );
  }

  const kept = filterGames(all, filter);
  lines.push(
    `выборка: --games=${filter.who} --overlay=${filter.overlay}` +
      ` → партий ${String(kept.length)} из ${String(all.length)}`,
  );
  if (filter.who === 'own' && theirGames > 0) {
    lines.push(
      `  чужие партии НЕ вошли: имитация покупок на них мерит уровень` +
        ` исполнителя, а не советника (см. provenance.ts)`,
    );
  }
  return lines;
}
