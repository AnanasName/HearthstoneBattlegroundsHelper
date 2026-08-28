import { open, readFile } from 'node:fs/promises';

/**
 * Контейнер для передачи архива логов одним файлом — ustar своими руками.
 *
 * Зачем свой. Исполнитель присылает данные ОДНИМ файлом: папку из десятка
 * `.gz` в мессенджер не отправишь. У Node нет ни zip, ни tar в стандартной
 * библиотеке, а тянуть зависимость ради контейнера в проект с одной
 * зависимостью на рантайм не хочется: ustar — это 512-байтные заголовки
 * с полями в восьмеричной записи, читается и пишется в сотню строк,
 * и открывается штатным `tar.exe` Windows 11 (проверяется тестом).
 *
 * Сжатия у контейнера нет намеренно: содержимое — уже сжатые `.log.gz`
 * (лог жмётся в двадцать раз) плюс мелкие JSON; второй gzip поверх
 * ничего не даёт.
 *
 * Поддерживаются только обычные файлы. Имена короче ста байт пишутся
 * в поле `name`; длиннее — делятся по `/` на `prefix` и `name`, как велит
 * ustar; ещё длиннее у нас не бывает (имя сессии клиента — 32 символа).
 */

const BLOCK = 512;
const NAME_LEN = 100;
const PREFIX_LEN = 155;

export interface TarEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly mtime: Date;
}

export interface TarSource {
  readonly name: string;
  /** Содержимое либо путь к файлу — одно из двух. */
  readonly data?: Buffer;
  readonly path?: string;
  readonly mtime?: Date;
}

function octal(value: number, length: number): Buffer {
  // `length − 1` цифр плюс завершающий NUL — так пишут GNU tar и bsdtar.
  const digits = value.toString(8).padStart(length - 1, '0');
  if (digits.length > length - 1) throw new Error(`число ${String(value)} не влезает в поле tar`);
  return Buffer.from(`${digits}\0`, 'latin1');
}

function splitName(name: string): { name: string; prefix: string } {
  const bytes = Buffer.byteLength(name, 'utf8');
  if (bytes <= NAME_LEN) return { name, prefix: '' };

  // Делим по последнему `/`, при котором хвост влезает в name, а голова — в prefix.
  let cut = name.lastIndexOf('/');
  while (cut > 0) {
    const head = name.slice(0, cut);
    const tail = name.slice(cut + 1);
    if (Buffer.byteLength(tail, 'utf8') <= NAME_LEN && Buffer.byteLength(head, 'utf8') <= PREFIX_LEN) {
      return { name: tail, prefix: head };
    }
    cut = name.lastIndexOf('/', cut - 1);
  }
  throw new Error(`имя «${name}» не влезает в заголовок tar`);
}

/** Заголовок одного файла: 512 байт по формату ustar. */
export function tarHeader(fullName: string, size: number, mtime: Date): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  const { name, prefix } = splitName(fullName);

  header.write(name, 0, NAME_LEN, 'utf8');
  octal(0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(size, 12).copy(header, 124);
  octal(Math.floor(mtime.getTime() / 1000), 12).copy(header, 136);
  // Контрольная сумма считается при поле, заполненном пробелами.
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'latin1');
  header.write('ustar\0', 257, 6, 'latin1');
  header.write('00', 263, 2, 'latin1');
  header.write(prefix, 345, PREFIX_LEN, 'utf8');

  let sum = 0;
  for (const byte of header) sum += byte;
  // Шесть восьмеричных цифр, NUL, пробел — форма, которую понимают все.
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return header;
}

function padding(size: number): Buffer {
  const rest = size % BLOCK;
  return Buffer.alloc(rest === 0 ? 0 : BLOCK - rest, 0);
}

/**
 * Записать контейнер. Файлы читаются по одному, чтобы не держать в памяти
 * весь архив разом: у исполнителя за месяц набирается сотня мегабайт.
 * Возвращает размер контейнера в байтах.
 */
export async function writeTar(outPath: string, sources: readonly TarSource[]): Promise<number> {
  const handle = await open(outPath, 'w');
  let written = 0;
  try {
    for (const source of sources) {
      const data = source.data ?? (source.path === undefined ? null : await readFile(source.path));
      if (data === null) throw new Error(`у записи «${source.name}» нет ни данных, ни пути`);
      const chunks = [tarHeader(source.name, data.length, source.mtime ?? new Date()), data, padding(data.length)];
      for (const chunk of chunks) {
        await handle.write(chunk);
        written += chunk.length;
      }
    }
    const end = Buffer.alloc(BLOCK * 2, 0);
    await handle.write(end);
    written += end.length;
  } finally {
    await handle.close();
  }
  return written;
}

function readString(buffer: Buffer, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? length : nul).toString('utf8');
}

function readOctal(buffer: Buffer, offset: number, length: number): number {
  const text = readString(buffer, offset, length).trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

/** Прочитать контейнер целиком: обычные файлы, остальное пропускается. */
export function readTar(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    // Два нулевых блока — конец архива; проверяем первый.
    if (header.every((b) => b === 0)) break;

    const size = readOctal(header, 124, 12);
    const typeflag = header[156];
    const prefix = readString(header, 345, PREFIX_LEN);
    const name = readString(header, 0, NAME_LEN);
    const fullName = prefix === '' ? name : `${prefix}/${name}`;
    const start = offset + BLOCK;
    const isFile = typeflag === 0x30 || typeflag === 0;

    if (isFile) {
      if (start + size > buffer.length) throw new Error(`архив обрезан на «${fullName}»`);
      entries.push({
        name: fullName,
        data: Buffer.from(buffer.subarray(start, start + size)),
        mtime: new Date(readOctal(header, 136, 12) * 1000),
      });
    }
    offset = start + size + padding(size).length;
  }
  return entries;
}
