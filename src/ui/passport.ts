import { tavernTurnOf } from '../advisors/tavern/rules.js';
import { gameTypeOf, splitGames } from '../dataset/import.js';
import { splitLogLines } from '../parser/logLine.js';
import { reduceLog } from '../state/reducer.js';
import { BATTLEGROUNDS_GAME_TYPE } from '../state/types.js';
import { clockText, DAY, lineSeconds, type Clock } from './logSlice.js';

/**
 * Паспорт партии — всё, что проверялось руками при приёме каждой фикстуры.
 *
 * Проверка чистоты лога описана в CLAUDE.md прозой десять раз («один
 * GT_BATTLEGROUNDS, ноль GT_RANKED, доиграна до FINAL_GAMEOVER») и скопирована
 * дословно в девять тестов партий, а у part1–part44 её нет вовсе. Каждый пункт
 * стоил отдельного урока:
 *
 * - **режим:** игрок играет рейтинговые партии той же сессией клиента,
 *   и в одном Power.log их бывает несколько (part38);
 * - **доиграна:** без `FINAL_GAMEOVER` поле места — ТЕКУЩЕЕ место,
 *   и обрезанный лог дал 1-е место вместо 3-го (part38);
 * - **часы:** кадры part49 оказались из ДРУГОЙ партии той же сессии,
 *   и узнать это можно только по времени.
 *
 * Паспорт ничего не пишет и ничего не решает: он называет факты, а выбор
 * партии остаётся за тем, кто принимает фикстуру.
 */

export interface GameRange {
  /** Номер партии в тексте, с единицы. */
  readonly index: number;
  /** Смещения в исходном тексте: партия вырезается байт в байт. */
  readonly from: number;
  readonly to: number;
}

export interface GamePassport extends GameRange {
  readonly gameType: string | null;
  readonly battlegrounds: boolean;
  readonly buildNumber: number | null;
  readonly heroCardId: string | null;
  /** Место в таблице. У недоигранной партии это текущее место, а не итог. */
  readonly place: number | null;
  readonly finished: boolean;
  /** Партия начинается с дампа переподключения, без CREATE_GAME. */
  readonly reconnect: boolean;
  readonly tavernTurns: number;
  /**
   * Часы начала и конца, `13:52:01`. Конец — строка `FINAL_GAMEOVER`, если
   * она есть: после неё в сессии идут строки лобби, иногда часами, и последняя
   * метка текста назвала бы партию двухчасовой, а кадр между партиями
   * приписала бы первой.
   */
  readonly start: string;
  readonly end: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

/**
 * Границы партий в тексте сессии — по строкам CREATE_GAME канала-источника.
 *
 * Резать надо ИСХОДНЫЙ текст, а не склеивать строки обратно: в логе
 * смешаны CRLF и одиночные LF, и фикстура обязана лечь на диск как есть.
 * Текст без CREATE_GAME (сегмент переподключения) — одна партия целиком.
 */
export function gameRanges(text: string): GameRange[] {
  const games = splitGames(text);
  if (games.length === 0) return text.trim() === '' ? [] : [{ index: 1, from: 0, to: text.length }];

  const starts: number[] = [];
  let cursor = 0;
  for (const game of games) {
    const firstLine = game.split('\n', 1)[0] ?? '';
    const at = text.indexOf(firstLine, cursor);
    starts.push(at < 0 ? cursor : at);
    cursor = (at < 0 ? cursor : at) + firstLine.length;
  }
  return starts.map((from, i) => ({ index: i + 1, from, to: starts[i + 1] ?? text.length }));
}

export function passportOf(text: string, range: GameRange): GamePassport {
  const body = text.slice(range.from, range.to);
  const state = reduceLog(body);
  const gameType = gameTypeOf(body);
  const lines = splitLogLines(body);
  const seconds = lineSeconds(lines);
  const stamped = seconds.filter((s): s is number => s !== null);
  const over = lines.findIndex((l) => l.includes('GameState.DebugPrintPower()') && l.includes('FINAL_GAMEOVER'));
  const start = stamped[0] ?? null;
  const end = (over >= 0 ? seconds[over] : null) ?? stamped[stamped.length - 1] ?? null;
  return {
    ...range,
    gameType,
    battlegrounds: gameType === null || gameType === BATTLEGROUNDS_GAME_TYPE,
    buildNumber: state.buildNumber,
    heroCardId: state.hero?.cardId ?? null,
    place: state.finalPlace,
    finished: body.includes('FINAL_GAMEOVER'),
    reconnect: !body.includes('CREATE_GAME'),
    tavernTurns: tavernTurnOf(state.turn),
    start: start === null ? '—' : clockText(start),
    end: end === null ? '—' : clockText(end),
    startSeconds: start ?? 0,
    endSeconds: end ?? 0,
  };
}

export function passportsOf(text: string): GamePassport[] {
  return gameRanges(text).map((range) => passportOf(text, range));
}

/**
 * В какую партию попадает кадр: номер или `null`. Кадр без секунд — вся
 * его минута; партия через полночь проверяется и со сдвигом на сутки.
 */
export function gameOfFrame(passports: readonly GamePassport[], clock: Clock): number | null {
  const from = clock.precise ? clock.seconds : clock.seconds - (clock.seconds % 60);
  const until = clock.precise ? clock.seconds + 1 : from + 60;
  for (const p of passports) {
    for (const shift of [0, DAY]) {
      if (until + shift > p.startSeconds && from + shift <= p.endSeconds) return p.index;
    }
  }
  return null;
}
