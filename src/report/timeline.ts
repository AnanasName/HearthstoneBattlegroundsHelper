import {
  PowerEventAssembler,
  SOURCE_OF_TRUTH,
  SOURCE_SEND_CHOICES,
  type BlockContext,
  type PowerEvent,
  type Yielder,
} from '../parser/blocks.js';
import { parseLogLine, splitLogLines } from '../parser/logLine.js';
import { readPlayers } from '../state/players.js';
import { createReducer } from '../state/reducer.js';
import type { GameState } from '../state/types.js';
import { tavernTurnOf } from '../advisors/tavern/rules.js';
import { DAY, logClockSeconds } from '../ui/logSlice.js';

/**
 * Лента партии для послематчевого отчёта: что было у игрока в конце
 * каждого хода таверны и сколько времени ход у него занял.
 *
 * ## Зачем свой проход, а не `readTavernTurns`
 *
 * Точка решения (`turns.ts`) — НАЧАЛО хода: состояние до первой траты.
 * Отчёту нужно обратное — КОНЕЦ хода, где видно, что осталось
 * несделанным (золото, пустой слот, ненажатая сила), и борд, с которым
 * игрок ушёл в бой. Второе определение точки решения тут не заводится
 * (D168): лента дополняет точку решения, а не подменяет её.
 *
 * ## Два конца хода, и оба нужны
 *
 * Между `STEP=MAIN_END` и сменой `TURN` срабатывают триггеры конца хода:
 * у Ониксии борд 6 при `MAIN_END` становится 7 перед `TURN` (дракончик
 * силы Broodmother, part73, ходы 17/19/21). Поэтому снимков два:
 *
 *  - `end` — перед `MAIN_END`: что игрок оставил. Слот, который займёт
 *    дракончик, игрок не «забыл заполнить».
 *  - `beforeCombat` — перед `TURN=N+1`: с чем он ушёл в бой. Это борд
 *    для пересчёта боя; борд эпизода для этого не годится — он снят
 *    ПОСЛЕ Start of Combat, и симулятор применил бы эти эффекты второй
 *    раз (память hsbg-episode-board-after-soc: +5–13 п.п. на part56,
 *    до +62 п.п. на part33 у Al'Akir).
 *
 * `MAIN_END` хода таверны стоит на верхнем уровне
 * (part72:4777 `GameState.DebugPrintPower() - TAG_CHANGE Entity=GameEntity
 * tag=STEP value=MAIN_END`), а у боевого хода — внутри блока
 * (part72:6866, с отступом). Фильтр — фаза таверны и нечётный ход
 * на снимке, а не отступ: на отступ формат не обязывался.
 *
 * ## Время хода — по нажатиям игрока
 *
 * Ход таверны в Battlegrounds кончается ТОЛЬКО по таймеру: опция
 * `END_TURN` в логе всегда `error=INVALID` (part72 — 128 из 128).
 * Остаток ресурса поэтому означает одно из двух — не успел или оставил
 * сознательно, — и различает их пауза от последнего нажатия до конца
 * хода. Нажатие — строка `GameState.SendOption()` (part72:4305
 * `selectedOption=6 selectedSubOption=-1 selectedTarget=430
 * selectedPosition=0`) или выбор `GameState.SendChoices()` (раскопка,
 * тринкет). `SendOption` канал-источник не отдаёт событием, поэтому
 * проход идёт по сырым строкам тем же сборщиком событий, что у
 * `readPowerEvents`, и время нажатия берётся из самой строки.
 *
 * ## Снимки внутри хода
 *
 * Упущенную тройку видно не на конце хода, а в МОМЕНТ, когда третья
 * копия лежала в витрине: после обновления её уже нет. Снимок берётся
 * перед каждым новым верхним блоком `PLAY`/`POWER` хода таверны — это
 * состояние после предыдущего действия, то есть то, что игрок видел,
 * выбирая следующее. На партию это около двухсот снимков против тысяч
 * событий `ZONE`.
 */

/** Момент внутри хода таверны: что игрок видел перед очередным действием. */
export interface TurnMoment {
  /** Время строки лога: `20:17:20.1234567`. */
  readonly time: string;
  /** Секунды на сквозной шкале партии (через полночь не убывают). */
  readonly at: number;
  readonly state: GameState;
}

export interface TurnClock {
  /** Смена `TURN` на этот ход. */
  readonly startAt: number | null;
  /** `STEP=MAIN_END` хода таверны. */
  readonly mainEndAt: number | null;
  /** Последнее нажатие или выбор игрока до `MAIN_END`. */
  readonly lastClickAt: number | null;
  /** Нажатий (`SendOption`) за ход до `MAIN_END`. */
  readonly clicks: number;
  /** Выборов (`SendChoices`) за ход до `MAIN_END`. */
  readonly choices: number;
  /**
   * Последнее проигрывание боя клиентом (`PowerTaskList`, блок `ATTACK`)
   * в этом ходу. GameState проходит бой за секунду, а клиент показывает
   * его ещё 10–13 с (part73: TURN=25 в 20:15:45.50, последняя атака
   * показа в 20:16:29.67, первое нажатие в 20:16:36.95), и это время хода
   * игроку недоступно: медиана — 22 % хода, p90 — 61 %.
   */
  readonly replayEndAt: number | null;
  /**
   * Последнее нажатие не исполнено: после него до `MAIN_END` игра
   * не ответила ничем, кроме служебной `META_DATA` (part68:459256
   * `SendOption() - selectedOption=2 … selectedTarget=19004` в 21:44:00.28,
   * а следом только :459258 `META_DATA - Meta=ARTIFICIAL_HISTORY_INTERRUPT`
   * и :459259 `MAIN_END` в 21:44:03.97). Это единственный однозначный
   * признак того, что ход оборвал таймер: пауза до конца хода им не является.
   */
  readonly lastClickUnanswered: boolean;
}

export interface ReportTurn {
  /** Ход партии, нечётный. */
  readonly turn: number;
  readonly tavernTurn: number;
  /** Перед `MAIN_END`: что игрок оставил несделанным. */
  readonly end: GameState;
  /** Перед `TURN=N+1`: с чем ушёл в бой. `null` — партия кончилась раньше. */
  readonly beforeCombat: GameState | null;
  /** Время строки `MAIN_END`. */
  readonly endTime: string;
  readonly moments: readonly TurnMoment[];
  readonly clock: TurnClock;
  /**
   * Карты, которые игрок брал и отпускал (`BLOCK_START BlockType=MOVE_MINION`
   * без смены зоны): перетаскивание миньона витрины, не донесённое до руки,
   * пишется пустым блоком. part73:326223 — Goldrinn `id=18299`, взятый
   * в 20:17:16.03 (:326197 `SendOption() - selectedOption=12`) и отпущенный
   * на своё место. На 30 партиях таких перетаскиваний из витрины 112,
   * из них 90 кончаются покупкой того же хода.
   */
  readonly drags: readonly { readonly entityId: number; readonly time: string }[];
}

export interface GameTimeline {
  readonly turns: readonly ReportTurn[];
  /** Состояние на конце текста — журнал действий, место, герой. */
  readonly final: GameState;
  /** Первая и последняя метки времени партии, как в логе. */
  readonly firstTime: string | null;
  readonly lastTime: string | null;
}

const TURN_RE = /^TAG_CHANGE Entity=GameEntity tag=TURN value=(\d+)$/;
const MAIN_END = 'TAG_CHANGE Entity=GameEntity tag=STEP value=MAIN_END';
const SEND_OPTION = 'GameState.SendOption';
/** Показ боя клиентом — дубль канала-источника, в состояние не идёт. */
const REPLAY_ATTACK = /^[A-Z] (\S+) PowerTaskList\.DebugPrintPower\(\) -\s+BLOCK_START BlockType=ATTACK /;
const MOVE_MINION =
  /^[A-Z] (\S+) GameState\.DebugPrintPower\(\) -\s+BLOCK_START BlockType=MOVE_MINION Entity=\[.*? id=(\d+) zone=/;
/** Служебная строка, которую игра пишет перед обрывом хода, — не ответ на нажатие. */
const HISTORY_INTERRUPT = 'META_DATA - Meta=ARTIFICIAL_HISTORY_INTERRUPT';
/** Действия, перед которыми снимается момент хода. */
const ACTION_BLOCKS = new Set(['PLAY', 'POWER']);

interface OpenTurn {
  turn: number;
  startAt: number | null;
  mainEndAt: number | null;
  endTime: string | null;
  lastClickAt: number | null;
  clicks: number;
  choices: number;
  replayEndAt: number | null;
  /** После последнего нажатия игра ещё ничего не ответила. */
  pendingClick: boolean;
  lastClickUnanswered: boolean;
  end: GameState | null;
  moments: TurnMoment[];
  drags: { entityId: number; time: string }[];
}

/** Секунды со сквозной шкалой: часы не убывают больше чем на полдня. */
function createClock(): (time: string) => number | null {
  let day = 0;
  let prev = -1;
  return (time) => {
    const raw = logClockSeconds(time);
    if (raw === null) return null;
    if (prev >= 0 && raw + day < prev - DAY / 2) day += DAY;
    prev = raw + day;
    return prev;
  };
}

function isTavernTurn(state: GameState): boolean {
  return state.phase === 'tavern' && state.turn > 0 && state.turn % 2 === 1 && state.hero !== null;
}

/** Накопитель ленты — по сырой строке за раз, один на оба пути чтения. */
function createTimelineCollector(text: string): {
  push(raw: string): void;
  finish(): GameTimeline;
} {
  const reducer = createReducer(readPlayers(text));
  const assembler = new PowerEventAssembler();
  const clock = createClock();
  const done: ReportTurn[] = [];

  let open: OpenTurn | null = null;
  let topBlock: BlockContext | null = null;
  let firstTime: string | null = null;
  let lastTime: string | null = null;

  const close = (beforeCombat: GameState | null): void => {
    if (open?.end != null && open.endTime !== null) {
      done.push({
        turn: open.turn,
        tavernTurn: tavernTurnOf(open.turn),
        end: open.end,
        beforeCombat,
        endTime: open.endTime,
        moments: open.moments,
        clock: {
          startAt: open.startAt,
          mainEndAt: open.mainEndAt,
          lastClickAt: open.lastClickAt,
          clicks: open.clicks,
          choices: open.choices,
          replayEndAt: open.replayEndAt,
          lastClickUnanswered: open.lastClickUnanswered,
        },
        drags: open.drags,
      });
    }
    open = null;
  };

  const onEvent = (event: PowerEvent, at: number | null): void => {
    const { content } = event.line;

    if (event.line.source === SOURCE_SEND_CHOICES) {
      // Выбор приходит двумя строками и больше (`id=… ChoiceType=…` и по
      // строке на выбранную сущность); выбором считается первая.
      if (open !== null && open.mainEndAt === null && content.startsWith('id=')) {
        open.choices += 1;
        if (at !== null) open.lastClickAt = at;
      }
      reducer.step(event);
      return;
    }

    if (event.line.source === SOURCE_OF_TRUTH) {
      const turnMatch = TURN_RE.exec(content);
      if (turnMatch !== null) {
        // Смена хода: всё, что игра сделала до неё, уже на борде — это
        // и есть «с чем ушёл в бой» для хода, который кончается.
        const snapshot = reducer.snapshot();
        if (open !== null) close(isTavernTurn(snapshot) ? snapshot : null);
        const next = Number(turnMatch[1]);
        if (next % 2 === 1) {
          open = {
            turn: next,
            startAt: at,
            mainEndAt: null,
            endTime: null,
            lastClickAt: null,
            clicks: 0,
            choices: 0,
            replayEndAt: null,
            pendingClick: false,
            lastClickUnanswered: false,
            end: null,
            moments: [],
            drags: [],
          };
        }
      } else if (content === MAIN_END && open !== null && open.mainEndAt === null) {
        const snapshot = reducer.snapshot();
        if (isTavernTurn(snapshot) && snapshot.turn === open.turn) {
          open.end = snapshot;
          open.mainEndAt = at;
          open.endTime = event.line.time;
          open.lastClickUnanswered = open.pendingClick;
        }
      } else {
        // Любая строка канала-источника, кроме служебной перед обрывом, —
        // ответ игры на последнее нажатие.
        if (open !== null && open.pendingClick && !content.startsWith(HISTORY_INTERRUPT)) {
          open.pendingClick = false;
        }
        const outer = event.blocks[0] ?? null;
        if (
          outer !== null &&
          outer !== topBlock &&
          ACTION_BLOCKS.has(outer.blockType) &&
          open !== null &&
          open.mainEndAt === null &&
          at !== null
        ) {
          const snapshot = reducer.snapshot();
          if (isTavernTurn(snapshot) && snapshot.turn === open.turn) {
            open.moments.push({ time: event.line.time, at, state: snapshot });
          }
        }
      }
      topBlock = event.blocks[0] ?? null;
    }

    reducer.step(event);
  };

  const push = (raw: string): void => {
    // Нажатие канал-источник событием не отдаёт — время берётся из строки.
    // Дешёвая проверка подстрокой прежде разбора: нажатий сотня на партию,
    // строк — сотни тысяч.
    if (raw.includes(SEND_OPTION)) {
      const line = parseLogLine(raw);
      if (line !== null && line.source === SEND_OPTION) {
        const at = clock(line.time);
        if (open !== null && open.mainEndAt === null) {
          open.clicks += 1;
          open.pendingClick = true;
          if (at !== null) open.lastClickAt = at;
        }
        return;
      }
    }

    // Показ боя и перетаскивания — строки, которые событием не становятся:
    // первая идёт другим каналом, вторая — строка BLOCK_START.
    if (open !== null && open.mainEndAt === null) {
      if (raw.includes('PowerTaskList.DebugPrintPower') && raw.includes('BlockType=ATTACK')) {
        const m = REPLAY_ATTACK.exec(raw);
        const at = m?.[1] === undefined ? null : clock(m[1]);
        if (at !== null && open.lastClickAt === null) open.replayEndAt = at;
      } else if (raw.includes('BlockType=MOVE_MINION')) {
        const m = MOVE_MINION.exec(raw);
        if (m?.[1] !== undefined && m[2] !== undefined) {
          open.drags.push({ entityId: Number(m[2]), time: m[1] });
        }
      }
    }

    const event = assembler.push(raw);
    if (event === null) return;
    const at = clock(event.line.time);
    firstTime ??= event.line.time;
    lastTime = event.line.time;
    onEvent(event, at);
  };

  const finish = (): GameTimeline => {
    // Партия, кончившаяся посреди хода таверны (сдача, обрыв), хода
    // не закрывает: без `MAIN_END` конца хода нет, и `close` его отбросит.
    if (open !== null) close(null);
    return { turns: done, final: reducer.snapshot(), firstTime, lastTime };
  };

  return { push, finish };
}

export function readTimeline(text: string): GameTimeline {
  const collector = createTimelineCollector(text);
  for (const raw of splitLogLines(text)) collector.push(raw);
  return collector.finish();
}

/**
 * Та же лента с паузами — для тестов и воркера: проход по 85 МБ держит
 * поток десятки секунд, а воркер vitest падает по таймауту RPC через
 * минуту (test/breather.ts). Накопитель один, результат тот же.
 */
export async function readTimelineAsync(text: string, yielder: Yielder): Promise<GameTimeline> {
  const collector = createTimelineCollector(text);
  for (const raw of splitLogLines(text)) {
    if (yielder.due()) await yielder.pause();
    collector.push(raw);
  }
  return collector.finish();
}

/** Пауза от последнего нажатия до конца хода, с. `null` — нажатий не было. */
export function idleBeforeEnd(clock: TurnClock): number | null {
  if (clock.lastClickAt === null || clock.mainEndAt === null) return null;
  return clock.mainEndAt - clock.lastClickAt;
}

/**
 * Время хода, доступное игроку, с: от конца показа боя (или смены `TURN`,
 * если показа не было) до `MAIN_END`.
 */
export function turnSeconds(clock: TurnClock): number | null {
  if (clock.startAt === null || clock.mainEndAt === null) return null;
  const from = Math.max(clock.startAt, clock.replayEndAt ?? clock.startAt);
  return clock.mainEndAt - from;
}
