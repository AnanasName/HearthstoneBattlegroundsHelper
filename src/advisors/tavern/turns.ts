import { readPowerEvents, type BlockContext } from '../../parser/blocks.js';
import { readPlayers } from '../../state/players.js';
import { createReducer } from '../../state/reducer.js';
import type { GameState } from '../../state/types.js';

/**
 * Точки решения в таверне — состояния, в которых советник имеет смысл.
 *
 * Нужно по той же причине, что и `readBattleEpisodes` для фазы 2: тесты
 * и демо должны работать на реальных состояниях, а не на выдуманных.
 *
 * Момент выбран началом фазы таверны, и это не мелочь. Демо фазы 1 печатает
 * КОНЕЦ фазы, где золото всегда 0 из 10: человек к тому времени всё потратил.
 * Советовать в этой точке нечего. Решения принимаются в начале хода, когда
 * витрина только что обновилась, а золото ещё целое.
 */

export interface TavernTurn {
  readonly turn: number;
  /** Состояние на момент, когда ходить ещё не начали. */
  readonly state: GameState;
}

/**
 * Точка решения — ПОСЛЕДНЕЕ состояние хода, в котором золото ещё не тронуто.
 *
 * Первая версия брала первое такое состояние и оказалась негодной: витрина
 * наполняется не мгновенно, и снимок заставал в ней одного миньона вместо
 * трёх-пяти. Демо это показало сразу, а тесты бы не заметили — они не знают,
 * сколько миньонов в магазине должно быть.
 *
 * Ждать «полной витрины» по числу мест нельзя: размер магазина зависит от тира
 * и меняется с патчами, а таблицы этого в логе нет. Зато момент, когда игрок
 * впервые тратит золото, в логе есть, и он же и есть точка решения — всё, что
 * игра успела показать к этому моменту, игрок видел.
 */
/**
 * ## Снимок берётся ПЕРЕД действием, которое тратит золото
 *
 * Снимок дорогой, поэтому по ходу он берётся только на событиях, которые
 * могут изменить витрину, золото или борд (`ZONE`, `RESOURCES`,
 * `BOARD_VISUAL_STATE`). Но «последнее состояние до траты» — это состояние
 * со ВСЕМИ событиями до неё, включая те, что фильтр не замечает: усиление
 * тегом `ATK` без смены зоны, тир соперника в таблице лобби, закрытый
 * выбор тринкета. Живой путь (`DatasetRecorder` в оверлее) их видит —
 * он снимает состояние на конце порции, — и на part7 пакетная точка
 * отставала от живой на усиление: атака 44 против 48 (замер 29.08,
 * docs/collector.md).
 *
 * Границей служит не сама строка `RESOURCES_USED`, а НАЧАЛО ДЕЙСТВИЯ:
 * трата приходит внутри блока `PLAY` (покупка, сила героя, дар), и первые
 * строки блока уже меняют состояние — флаг «сила нажата» ставится
 * на BLOCK_START, а золото списывается строкой позже (part30). Снимок
 * «перед событием траты» попал бы внутрь действия, и совет по силе героя
 * на такой точке молчал бы (part11, ход 5). Строки BLOCK_START событиями
 * не являются — первое событие внутри блока несёт весь открытый стек,
 * и объект верхнего блока в нём один и тот же до конца блока, — поэтому
 * состояние снимается перед первым событием каждого нового верхнего
 * блока, а трата вне блоков (тринкет за золото, part32) — перед самим
 * событием. Снимков это добавляет по одному на верхний блок хода до первой
 * траты — единицы против тысяч на `ZONE`.
 */
export function readTavernTurns(text: string): TavernTurn[] {
  const reducer = createReducer(readPlayers(text));
  const turns: TavernTurn[] = [];

  let pending: TavernTurn | null = null;
  /** Верхний блок предыдущего события — чтобы заметить начало нового. */
  let topBlock: BlockContext | null = null;
  /** Состояние перед действием, которое может оказаться тратой. */
  let beforeAction: GameState | null = null;

  const commit = (): void => {
    if (pending !== null && pending.state.shop.length > 0) turns.push(pending);
    pending = null;
  };

  for (const event of readPowerEvents(text)) {
    const { content } = event.line;
    const notable =
      content.includes('ZONE') || content.includes('RESOURCES') || content.includes('BOARD_VISUAL_STATE');

    // Снимок нужен только пока у хода есть точка решения и золото цело:
    // до первого снимка хода тратить ещё нечего, после первой траты
    // снимок уже взят.
    const outer = event.blocks[0] ?? null;
    if (pending !== null && pending.state.goldSpent === 0) {
      if (outer !== null ? outer !== topBlock : content.includes('RESOURCES')) {
        beforeAction = reducer.snapshot();
      }
    }
    topBlock = outer;

    reducer.step(event);
    if (!notable) continue;

    const state = reducer.snapshot();

    if (state.phase !== 'tavern' || state.turn === 0 || state.hero === null) {
      commit();
      continue;
    }
    if (pending !== null && pending.turn !== state.turn) commit();
    // Золото тронуто — решение уже принято. Точка решения — состояние
    // перед действием, со всем, что случилось после прошлого снимка.
    if (state.goldSpent > 0) {
      if (
        beforeAction !== null &&
        pending !== null &&
        pending.turn === state.turn &&
        beforeAction.turn === state.turn &&
        beforeAction.goldSpent === 0
      ) {
        pending = { turn: state.turn, state: beforeAction };
      }
      continue;
    }
    if (state.goldTotal === 0) continue;

    pending = { turn: state.turn, state };
  }

  commit();
  return turns;
}
