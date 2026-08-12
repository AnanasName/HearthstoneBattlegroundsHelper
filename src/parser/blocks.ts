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

export interface BlockContext {
  /** TRIGGER, POWER, PLAY, ATTACK, DEATHS, MOVE_MINION. */
  readonly blockType: string;
  /** Сущность-источник блока, как она записана после `Entity=`. */
  readonly entity: EntityRef | null;
  /** Идентификатор источника, если он выводится из ссылки. */
  readonly entityId: number | null;
  /** Отступ строки BLOCK_START — по нему блок и закрывается. */
  readonly indent: number;
}

export interface PowerEvent {
  readonly line: LogLine;
  /** Открытые блоки от внешнего к внутреннему на момент события. */
  readonly blocks: readonly BlockContext[];
}

const BLOCK_TYPE_RE = /^BLOCK_START BlockType=(\w+)/;

function parseBlockStart(line: LogLine): BlockContext | null {
  const m = BLOCK_TYPE_RE.exec(line.content);
  if (m === null) return null;

  const blockType = m[1];
  if (blockType === undefined) return null;

  const entity = parseEntityFrom(line.content);
  return {
    blockType,
    entity,
    entityId: entity === null ? null : entityIdOf(entity),
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
    if (line === null || line.source !== SOURCE_OF_TRUTH) return null;

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
