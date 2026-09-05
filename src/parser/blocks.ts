import { parseEntityFrom, type EntityRef, entityIdOf } from './entity.js';
import { parseLogLine, splitLogLines, type LogLine } from './logLine.js';

/**
 * Сборка блоков Power.log в поток событий с контекстом вложенности.
 *
 * ## Почему канал GameState
 *
 * `GameState.DebugPrintPower` и `PowerTaskList.DebugPrintPower` дублируют друг
 * друга. На эталонной партии их числа совпадают в точности: TAG_CHANGE 57 391
 * и там и там, BLOCK_START 3469, FULL_ENTITY 2425, SHOW_ENTITY 1349.
 * Применять оба нельзя — теги применились бы дважды.
 *
 * Выбран GameState по двум измеренным причинам:
 *
 * 1. Приходит раньше. Из 27 031 сопоставимых событий GameState был первым
 *    в 20 677 случаях против 131 у PowerTaskList. Для советника в реальном
 *    времени это прямая экономия задержки.
 * 2. Именует сущности числовыми id, тогда как PowerTaskList подставляет имена:
 *      GameState:      TAG_CHANGE Entity=11            tag=PLAYSTATE value=PLAYING
 *      PowerTaskList:  TAG_CHANGE Entity=AngryMem#2886 tag=PLAYSTATE value=PLAYING
 *    Числовой id однозначен и не зависит от локализации клиента.
 *
 * ## Почему вложенность считается по отступу, а не по BLOCK_END
 *
 * BLOCK_END есть не у каждого BLOCK_START: на эталонной партии 3469 открытий
 * против 3431 закрытий, 38 блоков остаются незакрытыми — одинаково в обоих
 * каналах, то есть это свойство лога, а не сбой записи. Стек, ждущий BLOCK_END,
 * копил бы глубину до конца партии.
 *
 * Отступ же кодирует структуру честно: BLOCK_END всегда идёт с тем же отступом,
 * что и открывший его BLOCK_START, а содержимое блока — на 4 глубже. Поэтому
 * блок закрывается, как только встречена строка с отступом не больше его
 * собственного. BLOCK_END при этом остаётся полезной, но не обязательной меткой.
 */

export const SOURCE_OF_TRUTH = 'GameState.DebugPrintPower';

/**
 * Каналы модальных выборов. Открытие — заголовок с вариантами, закрытие —
 * `SendChoices` с тем же id. Идут мимо стека блоков: у этих каналов свой
 * отступ (2 у строк `Source=`/`Entities[i]=`), и пропуск их через общий
 * стек закрывал бы блоки DebugPrintPower посреди содержимого.
 *
 * `PowerTaskList` эти каналы не дублирует, применить дважды их нельзя.
 */
export const SOURCE_ENTITY_CHOICES = 'GameState.DebugPrintEntityChoices';
export const SOURCE_SEND_CHOICES = 'GameState.SendChoices';

/**
 * Канал метаданных партии: `BuildNumber=248348`, `GameType=…` — приходит
 * одним заходом сразу после CREATE_GAME. Пропускаются две строки: номер
 * билда (по нему приложение узнаёт, не отстал ли снапшот карт от патча;
 * part16: виден на 239-й строке каждой партии) и РЕЖИМ партии, по которому
 * отсекается чужая игра. Тот же канал несёт имена игроков — их читает
 * `readPlayers` отдельно.
 */
export const SOURCE_GAME_INFO = 'GameState.DebugPrintGame';

export interface BlockContext {
  /** TRIGGER, POWER, PLAY, ATTACK, DEATHS, MOVE_MINION. */
  readonly blockType: string;
  /** Сущность-источник блока, как она записана после `Entity=`. */
  readonly entity: EntityRef | null;
  /** Идентификатор источника, если он выводится из ссылки. */
  readonly entityId: number | null;
  /**
   * Цель блока из `Target=[…]` — у покупки и продажи это карта-цель
   * (part17: `Entity=[…DragBuy…] Target=[…Трескучий циклон…]`).
   * `Target=0` — без цели, здесь null.
   */
  readonly target: EntityRef | null;
  /**
   * Какую ветвь модального «Choose One» выбрал игрок: 0 — первая, 1 —
   * вторая. `SubOption=-1` (у подавляющего большинства блоков) значит
   * «выбора не было» и читается здесь как `null`.
   *
   * Это ЕДИНСТВЕННЫЙ след такого выбора в логе: у модального миньона ветви
   * создаются сущностями в `SETASIDE` ещё при появлении карты в витрине,
   * а не при розыгрыше, и канал `DebugPrintEntityChoices` для него молчит
   * (part28, docs/power-log.md).
   */
  readonly subOption: number | null;
  /** Отступ строки BLOCK_START — по нему блок и закрывается. */
  readonly indent: number;
}

export interface PowerEvent {
  readonly line: LogLine;
  /** Открытые блоки от внешнего к внутреннему на момент события. */
  readonly blocks: readonly BlockContext[];
}

const BLOCK_TYPE_RE = /^BLOCK_START BlockType=(\w+)/;
const SUB_OPTION_RE = /\bSubOption=(-?\d+)/;

function parseBlockStart(line: LogLine): BlockContext | null {
  const m = BLOCK_TYPE_RE.exec(line.content);
  if (m === null) return null;

  const blockType = m[1];
  if (blockType === undefined) return null;

  const entity = parseEntityFrom(line.content);
  const target = parseEntityFrom(line.content, 'Target=');
  const sub = SUB_OPTION_RE.exec(line.content);
  const subOption = sub?.[1] === undefined ? null : Number(sub[1]);
  return {
    blockType,
    entity,
    entityId: entity === null ? null : entityIdOf(entity),
    // `Target=0` разбирается в голый id 0 — это «без цели», не сущность.
    target: target !== null && entityIdOf(target) === 0 ? null : target,
    // −1 значит «выбора не было»; нулём его подменять нельзя — ноль
    // это ПЕРВАЯ ветвь, настоящий выбор игрока.
    subOption: subOption === null || subOption < 0 ? null : subOption,
    indent: line.indent,
  };
}

/**
 * Сборка событий из строк по одной, со стеком блоков между вызовами.
 *
 * Живому режиму лог приходит порциями произвольной границы, и стек обязан
 * переживать порцию: блок открывается в одной, а его содержимое приходит
 * в следующей. Пакетный `readPowerEvents` построен на этом же классе, чтобы
 * оба пути не разъехались.
 */
export class PowerEventAssembler {
  #stack: BlockContext[] = [];

  /** Событие, если строка его несёт; null для чужих каналов и границ блоков. */
  push(raw: string): PowerEvent | null {
    const line = parseLogLine(raw);
    if (line === null) return null;

    // Строки выборов отдаются как события с пустым стеком: они приходят
    // между блоками канала-источника, и их отступ к его вложенности
    // отношения не имеет.
    if (line.source === SOURCE_ENTITY_CHOICES || line.source === SOURCE_SEND_CHOICES) {
      return { line, blocks: [] };
    }

    // Из канала метаданных пропускаются номер билда и РЕЖИМ партии;
    // остальное там либо читается отдельно (имена игроков), либо не нужно.
    // Режим добавлен 06.09: без него обычная партия Hearthstone попадала
    // в датасет как партия Battlegrounds — её мана читается золотом,
    // а чужие карты витриной (замер на живом логе из шести `GT_RANKED`).
    if (line.source === SOURCE_GAME_INFO) {
      const meta =
        line.content.startsWith('BuildNumber=') || line.content.startsWith('GameType=');
      return meta ? { line, blocks: [] } : null;
    }

    if (line.source !== SOURCE_OF_TRUTH) return null;

    // Блок живёт, пока идут строки с отступом строго больше его собственного.
    while (this.#stack.length > 0) {
      const top = this.#stack[this.#stack.length - 1];
      if (top === undefined || line.indent > top.indent) break;
      this.#stack.pop();
    }

    const started = parseBlockStart(line);
    if (started !== null) {
      this.#stack.push(started);
      return null;
    }

    if (line.content === 'BLOCK_END') return null;

    return { line, blocks: [...this.#stack] };
  }

  /** Забыть открытые блоки — на новой партии их досчитывать не по чему. */
  reset(): void {
    this.#stack = [];
  }

  get depth(): number {
    return this.#stack.length;
  }
}

/**
 * Проходит по строкам канала-источника и отдаёт каждое событие вместе со стеком
 * блоков, внутри которых оно произошло.
 *
 * Сами строки BLOCK_START и BLOCK_END событиями не считаются: первая уже
 * представлена в стеке, вторая только закрывает блок.
 */
export function* readPowerEvents(text: string): Generator<PowerEvent> {
  const assembler = new PowerEventAssembler();

  for (const raw of splitLogLines(text)) {
    const event = assembler.push(raw);
    if (event !== null) yield event;
  }
}

/** Тип самого внутреннего блока — например, ATTACK для событий боя. */
export function innermostBlockType(event: PowerEvent): string | null {
  return event.blocks[event.blocks.length - 1]?.blockType ?? null;
}

/** Находится ли событие внутри блока указанного типа на любой глубине. */
export function insideBlock(event: PowerEvent, blockType: string): boolean {
  return event.blocks.some((b) => b.blockType === blockType);
}
