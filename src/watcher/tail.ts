import { open, stat } from 'node:fs/promises';

export interface TailRead {
  /** Байты, дописанные с прошлого чтения. */
  readonly data: Buffer;
  /** Файл стал короче прочитанного офсета — его обрезали или заменили. */
  readonly restarted: boolean;
}

/**
 * Чтение дописываемого файла порциями.
 *
 * Дескриптор открывается на каждый опрос, а не держится постоянно: Hearthstone
 * держит Power.log открытым сам, файл может быть обрезан или заменён между
 * опросами, а накладные расходы на open/close раз в секунду ничтожны.
 *
 * Читаем байты, а не текст: граница порции может разрезать многобайтовый символ
 * UTF-8, поэтому склейка в строки — забота вызывающего кода.
 */
export class FileTailer {
  readonly #path: string;
  #offset: number;

  constructor(path: string, startOffset = 0) {
    this.#path = path;
    this.#offset = startOffset;
  }

  get path(): string {
    return this.#path;
  }

  /** Сколько байт файла уже прочитано. */
  get offset(): number {
    return this.#offset;
  }

  async read(): Promise<TailRead> {
    let size: number;
    try {
      size = (await stat(this.#path)).size;
    } catch {
      // Файла ещё нет либо он уже удалён — это не ошибка, просто читать нечего.
      return { data: Buffer.alloc(0), restarted: false };
    }

    let restarted = false;
    if (size < this.#offset) {
      this.#offset = 0;
      restarted = true;
    }
    if (size === this.#offset) {
      return { data: Buffer.alloc(0), restarted };
    }

    const handle = await open(this.#path, 'r');
    try {
      const length = size - this.#offset;
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, this.#offset);
      this.#offset += bytesRead;
      return { data: buf.subarray(0, bytesRead), restarted };
    } finally {
      await handle.close();
    }
  }

  /**
   * Обнуляет файл-источник и сбрасывает офсет.
   *
   * Нужно, чтобы обойти предел Hearthstone в 10000 КБ, после которого клиент
   * закрывает лог насовсем (см. docs/power-log.md).
   *
   * ВНИМАНИЕ: всё, что игра успела записать между последним read() и этим
   * вызовом, теряется безвозвратно. Вызывать сразу после read() и как можно реже.
   */
  async truncateSource(): Promise<void> {
    const handle = await open(this.#path, 'r+');
    try {
      await handle.truncate(0);
    } finally {
      await handle.close();
    }
    this.#offset = 0;
  }
}
