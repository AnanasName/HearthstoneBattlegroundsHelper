/**
 * Разбор одной строки Power.log на составные части.
 *
 * Формат подтверждён на фикстурах, см. docs/power-log.md:
 *
 *   D 00:17:32.3916963 GameState.DebugPrintPower() -     GameEntity EntityID=16
 *   │ │                │                                 └─ содержимое
 *   │ │                │                             └───── отступ = вложенность
 *   │ │                └─────────────────────────────────── источник, без "()"
 *   │ └──────────────────────────────────────────────────── время, 7 знаков долей
 *   └────────────────────────────────────────────────────── уровень
 *
 * Уровень вложенности задаётся отступом, и базовый отступ у каналов разный:
 * у `GameState.DebugPrintPower` он 0, у `PowerTaskList.DebugPrintPower` — 4.
 * Поэтому indent отдаётся как есть, без нормализации: что с ним делать, решает
 * тот, кто собирает блоки.
 */

/**
 * Источник — это не всегда `Класс.Метод`. В фикстурах встречается
 * `PowerSpellController [taskListId=2162].InitPowerSpell` — с пробелом и
 * скобками внутри, 24 раза за партию. Поэтому источник берётся нежадно
 * до первого `() -`, а не по списку допустимых символов.
 */
const LINE_RE = /^([A-Z]) (\d{2}:\d{2}:\d{2}\.\d+) (.+?)\(\) -(.*)$/;

export interface LogLine {
  /** Уровень: D — debug, W — warning. Других в фикстурах не встречалось. */
  readonly level: string;
  /** Время как в логе, без даты: `00:17:32.3916963`. */
  readonly time: string;
  /** Источник без скобок: `GameState.DebugPrintPower`. */
  readonly source: string;
  /** Ширина отступа содержимого в пробелах. */
  readonly indent: number;
  /** Содержимое без отступа и без хвостовых пробелов. */
  readonly content: string;
}

/**
 * Разбирает строку лога. Возвращает null для всего, что не является строкой
 * стандартного формата: пустых строк и баннера обрезки.
 */
export function parseLogLine(raw: string): LogLine | null {
  const m = LINE_RE.exec(raw);
  if (m === null) return null;

  const [, level, time, source, tail] = m;
  if (level === undefined || time === undefined || source === undefined || tail === undefined) {
    return null;
  }

  // После "() -" всегда идёт один пробел-разделитель, а всё, что за ним, —
  // уже значащий отступ.
  const body = tail.startsWith(' ') ? tail.slice(1) : tail;
  const trimmed = body.trimStart();

  return {
    level,
    time,
    source,
    indent: body.length - trimmed.length,
    content: trimmed.trimEnd(),
  };
}

/**
 * Баннер, которым клиент отмечает достижение предела размера файла.
 * После него запись прекращается навсегда — лог оборван, а не закончен.
 */
export function isTruncationBanner(raw: string): boolean {
  return raw.startsWith('Truncating log');
}

/** Строка-разделитель из рамки вокруг баннера обрезки. */
export function isBannerRule(raw: string): boolean {
  return raw.length > 0 && /^=+$/.test(raw);
}

/**
 * Разбивает текст лога на строки.
 *
 * Обычные строки клиент завершает CRLF, а рамку и баннер обрезки — одиночными
 * LF. Проверено побайтово на хвосте segment1.log:
 *
 *   ...errorParam=<CR><LF><LF><LF>====<LF>Truncating log...<LF>====<LF><CR><LF>
 *
 * Разбиение только по CRLF склеило бы весь баннер в одну строку и спрятало бы
 * тот факт, что лог оборван.
 */
export function splitLogLines(text: string): string[] {
  return text.split(/\r?\n/);
}
