import { readTavernTurns } from '../advisors/tavern/turns.js';
import { readPowerEvents, type BlockContext } from '../parser/blocks.js';
import { splitLogLines } from '../parser/logLine.js';
import { readPlayers } from '../state/players.js';
import { createReducer } from '../state/reducer.js';
import type { GameState, PlayerAction } from '../state/types.js';

/**
 * Срез партии по ЧАСАМ — воспроизведение кадра игрока.
 *
 * Кадры игрока почти всегда сняты В СЕРЕДИНЕ хода, а точка решения —
 * состояние ДО первой траты, и жалоба по ней не воспроизводится: так было
 * в part40, 43, 44, 45, 48, 49 и 50, то есть в семи партиях из последних
 * одиннадцати. Каждый раз срез писался одноразовым скриптом; здесь он один.
 *
 * Два решения, которых у одноразовых скриптов не было.
 *
 * **Часы сравниваются числом, с переходом через полночь.** Строкой «00:05»
 * меньше «23:55», и партия, начатая до полуночи, резалась бы на первой же
 * строке. В фикстурах такие партии есть рядом (part38 — 00:20, part46 —
 * 23:04), так что это вопрос времени, а не теории.
 *
 * **Срез говорит, попадает ли кадр в партию.** На part49 в каталоге уже
 * лежала свежая фикстура, и разбирать напрашивалось по ней, а часы кадра
 * показали, что он из ДРУГОЙ партии. Проверка стоит одной строки и отвечает
 * на вопрос раньше, чем тот станет дорогим.
 *
 * Часы на кадре Windows показывают минуты без секунд, а за минуту игрок
 * успевает купить и разыграть. Поэтому вместе с состоянием отдаются
 * действия игрока внутри этой минуты с точными секундами из лога.
 */

export const DAY = 86_400;
const HALF_DAY = DAY / 2;
/** Метка времени в начале строки лога: `D 13:53:59.7412345 GameState…`. */
const STAMP = /^[A-Z] (\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s/;

/** Часы из поля `time` строки лога (`13:53:59.7412345`) — секунды от полуночи. */
export function logClockSeconds(time: string): number | null {
  const m = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(time);
  if (m === null) return null;
  const frac = m[4] === undefined ? 0 : Number(`0.${m[4]}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

/** Часы, которые называет человек: `13:53`, `13:53:59`. */
export interface Clock {
  readonly seconds: number;
  /** Названы ли секунды. Без них кадр — вся минута. */
  readonly precise: boolean;
}

export function parseClock(text: string): Clock | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (m === null) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] === undefined ? 0 : Number(m[3]);
  if (h > 23 || min > 59 || sec > 59) return null;
  return { seconds: h * 3600 + min * 60 + sec, precise: m[3] !== undefined };
}

/** Секунды с учётом перехода через полночь: часы не убывают больше чем на полдня. */
function monotonic(): (raw: number) => number {
  let day = 0;
  let prev = -1;
  return (raw) => {
    if (prev >= 0 && raw + day < prev - HALF_DAY) day += DAY;
    prev = raw + day;
    return prev;
  };
}

/** Секунды каждой строки на сквозной шкале; у строки без метки — `null`. */
export function lineSeconds(lines: readonly string[]): (number | null)[] {
  const toScale = monotonic();
  return lines.map((line) => {
    const m = STAMP.exec(line);
    const raw = m === null ? null : logClockSeconds(m[1] as string);
    return raw === null ? null : toScale(raw);
  });
}

export interface LogSlice {
  /** Строки партии до конца кадра — секунды или минуты — включительно. */
  readonly text: string;
  /** Первая и последняя метки партии на сквозной шкале. */
  readonly start: number;
  readonly end: number;
  /** Кадр на той же шкале: начало его минуты и граница среза (не включая). */
  readonly frameStart: number;
  readonly frameEnd: number;
  /** Пересекается ли кадр с партией. `false` — кадр из другой партии. */
  readonly inGame: boolean;
}

/**
 * Режет текст партии по часам кадра. `null` — в тексте нет ни одной метки.
 *
 * Если партия переходит через полночь, одни и те же часы встречаются
 * на шкале дважды; берётся тот раз, что внутри партии.
 */
export function sliceLogByClock(text: string, clock: Clock): LogSlice | null {
  const lines = splitLogLines(text);
  const seconds = lineSeconds(lines);
  const stamped = seconds.filter((s): s is number => s !== null);
  const start = stamped[0];
  const end = stamped[stamped.length - 1];
  if (start === undefined || end === undefined) return null;

  // Кадр — от начала его минуты до конца названной секунды (или минуты).
  const minute = clock.seconds - (clock.seconds % 60);
  const until = clock.precise ? clock.seconds + 1 : minute + 60;
  const firstStamp = start;
  const lastStamp = end;
  const overlaps = (shift: number): boolean => until + shift > firstStamp && minute + shift <= lastStamp;
  const shift = overlaps(0) ? 0 : overlaps(DAY) ? DAY : 0;
  const frameStart = minute + shift;
  const frameEnd = until + shift;

  let cutAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const s = seconds[i];
    if (s != null && s >= frameEnd) {
      cutAt = i;
      break;
    }
  }

  return {
    text: lines.slice(0, cutAt).join('\n'),
    start,
    end,
    frameStart,
    frameEnd,
    inGame: overlaps(shift),
  };
}

export interface TimedAction {
  /** Часы строки, на которой игра записала действие: `13:12:53`. */
  readonly time: string;
  readonly action: PlayerAction;
}

export interface Frame {
  /** Состояние на конец кадра. */
  readonly state: GameState;
  /** Действия игрока с начала минуты кадра до среза. */
  readonly actions: readonly TimedAction[];
  /**
   * Точка решения того же хода — состояние до первой траты. `null`, если
   * ход ещё не дошёл до таверны или это не таверна.
   */
  readonly decisionPoint: GameState | null;
}

const sameStack = (a: readonly BlockContext[], b: readonly BlockContext[]): boolean =>
  a.length === b.length && a.every((block, i) => block === b[i]);

/**
 * Состояние на срезе и действия внутри минуты кадра.
 *
 * Журнал действий пишется на первом событии PLAY-блока, поэтому число
 * действий проверяется только там, где меняется стек блоков: время выходит
 * точным, а снимков состояния — десятки на минуту, а не тысячи.
 */
export function frameAt(slice: LogSlice): Frame {
  const reducer = createReducer(readPlayers(slice.text));
  const toScale = monotonic();
  const actions: TimedAction[] = [];
  let seen: number | null = null;
  let prevStack: readonly BlockContext[] = [];

  for (const event of readPowerEvents(slice.text)) {
    const raw = logClockSeconds(event.line.time);
    const s = raw === null ? null : toScale(raw);
    if (seen === null && s !== null && s >= slice.frameStart) {
      seen = reducer.snapshot().actions.length;
    }
    const changed = !sameStack(event.blocks, prevStack);
    prevStack = event.blocks;
    reducer.step(event);
    if (seen !== null && changed) {
      const journal = reducer.snapshot().actions;
      for (let i = seen; i < journal.length; i++) {
        actions.push({ time: event.line.time.slice(0, 8), action: journal[i] as PlayerAction });
      }
      seen = journal.length;
    }
  }

  const state = reducer.snapshot();
  if (seen !== null) {
    for (let i = seen; i < state.actions.length; i++) {
      actions.push({ time: '—', action: state.actions[i] as PlayerAction });
    }
  }

  const turns = readTavernTurns(slice.text);
  const last = turns[turns.length - 1];
  const decisionPoint = last !== undefined && last.turn === state.turn ? last.state : null;

  return { state, actions, decisionPoint };
}

/** Секунды шкалы обратно в часы: `13:12:57`. */
export function clockText(seconds: number): string {
  const s = Math.floor(seconds) % DAY;
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
