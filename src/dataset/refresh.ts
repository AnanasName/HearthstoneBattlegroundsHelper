import type { DatasetRecord } from './recorder.js';

/**
 * Что делать с записью партии, которая в датасете УЖЕ лежит, когда досбор
 * перечитал её лог сегодняшним редьюсером.
 *
 * Запись — снимок `GameState` того дня, когда она сделана, и поля, вошедшие
 * в состояние позже, в ней отсутствуют. Для большинства полей это лечит
 * загрузчик (`upgradeRecord` в `src/ml/dataset.ts`): умолчание из
 * `EMPTY_STATE` — ровно то, что записал бы редьюсер, не знай он тега.
 * Но `lobby` (таблица всех восьми игроков: тир, здоровье, место — part26)
 * умолчанием НЕ лечится: пустая таблица — не «неизвестно», а ложь, и признак
 * «моё hp против стола», посчитанный на ней, был бы мусором, совпадающим
 * с датой записи. На 28.08 `lobby` несут 10 записей из 38 — все с 26.08,
 * а первый замер фазы 6 (docs/ml.md) назвал относительные признаки первым
 * кандидатом на перезамер. Все старые партии при этом — фикстуры
 * part4–part26, и лог отдаёт таблицу лобби целиком; значит, недостающее
 * поле берётся не из умолчания, а из самого лога.
 *
 * Почему ПЕРЕСБОРКА точек, а не дописывание одного поля. Проба 28.08
 * по всем 23 партиям: свежие точки решения совпадают со старыми по числу
 * у 19 партий, а у четырёх — нет (part12 и part16: 14 → 15, part22:
 * 15 → 14, part24: 11 → 12): правка золота `TEMP_RESOURCES` (part34)
 * сдвинула, где «первая трата хода». Дописать `lobby` в старые точки
 * значило бы держать в одной записи точки одного редьюсера с таблицей
 * другого, да ещё и не по одному индексу. Запись, пересобранная целиком,
 * равна тому, что живой путь записал бы сегодня, — и это уже закреплено
 * тестом эквивалентности живого и пакетного путей. Отпечаток партии при
 * этом не меняется (первая точка решения у всех 23 та же — проверено той же
 * пробой), поэтому запись находится и перезаписывается под своим именем.
 *
 * Что сохраняется от старой записи: `savedAt` (имя файла живой записи —
 * это время), `contributor`, `contributorRating`, `overlay` — то, чего
 * в логе нет. Что берётся из свежей: точки решения и журнал действий.
 * Билд, герой и место у обеих одинаковы по построению отпечатка — кроме
 * записи, найденной по номеру фикстуры (`rebuildFromFixture`): у неё они
 * тоже из свежей.
 *
 * Дописывание только действий остаётся отдельной ветвью — для записи
 * текущей схемы, у которой журнала нет (так было до 19.08). Запись
 * с таблицей лобби и журналом не трогается вовсе.
 */

export type RefreshAction = 'rebuild' | 'patchActions' | 'keep';

export interface RefreshPlan {
  readonly action: RefreshAction;
  /** Запись, которую надо положить на место старой; при `keep` — она же. */
  readonly record: DatasetRecord;
}

/** Точки старой схемы: `lobby` там нет вовсе, а не пусто. */
type LegacyState = Omit<DatasetRecord['checkpoints'][number]['state'], 'lobby'> &
  Partial<Pick<DatasetRecord['checkpoints'][number]['state'], 'lobby'>>;

/**
 * Знает ли запись таблицу лобби хоть в одной точке.
 *
 * Достаточно одной: у записи текущей схемы таблица есть с первой точки
 * (редьюсер читает героев всех восьми игроков с CREATE_GAME), а у записи
 * старой схемы поля нет ни в одной. Пустой объект считается незнанием
 * наравне с отсутствием — запись с `lobby: {}` во всех точках могла
 * появиться только от редьюсера, который тега ещё не читал.
 */
export function lobbyKnown(record: DatasetRecord): boolean {
  return record.checkpoints.some((checkpoint) => {
    const state: LegacyState = checkpoint.state;
    return state.lobby !== undefined && Object.keys(state.lobby).length > 0;
  });
}

/**
 * `force` — пересобрать и запись текущей схемы: когда меняется само
 * определение точки решения (29.08 снимок стал браться перед событием
 * траты, а не на последнем ZONE-событии — `advisors/tavern/turns.ts`),
 * старые точки отличаются от новых не полями, а моментом, и по схеме
 * этого не видно. Паспорт записи сохраняется так же, как при обычной
 * пересборке.
 */
export function refreshRecord(stored: DatasetRecord, fresh: DatasetRecord, force = false): RefreshPlan {
  if (stored.fixturePart === undefined && fresh.fixturePart !== undefined) {
    return { action: 'rebuild', record: rebuildFromFixture(stored, fresh) };
  }
  if (force || !lobbyKnown(stored)) {
    return {
      action: 'rebuild',
      record: { ...stored, checkpoints: fresh.checkpoints, actions: fresh.actions },
    };
  }
  if (stored.actions === undefined) {
    return { action: 'patchActions', record: { ...stored, actions: fresh.actions } };
  }
  return { action: 'keep', record: stored };
}

/**
 * Запись той же партии, найденная НЕ по отпечатку, а по номеру фикстуры
 * или по первой точке (19.09): всё, что берётся из лога, — из свежего
 * разбора, включая героя и место, которые у такой записи и расходятся
 * (part10 и part46 — герой до подмены D200, part44 — место до D235,
 * part31 — 7-е место вместо 6-го), а обрывок после перезапуска клиента
 * (part35, part41) становится партией целиком. Паспорт — от старой.
 */
function rebuildFromFixture(stored: DatasetRecord, fresh: DatasetRecord): DatasetRecord {
  return {
    ...stored,
    buildNumber: fresh.buildNumber,
    heroCardId: fresh.heroCardId,
    finalPlace: fresh.finalPlace,
    checkpoints: fresh.checkpoints,
    actions: fresh.actions,
    fixturePart: fresh.fixturePart,
  };
}
