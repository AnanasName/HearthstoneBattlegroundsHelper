import { StringDecoder } from 'node:string_decoder';

/**
 * Склейка байтовых порций в строки лога.
 *
 * `FileTailer` отдаёт байты, а не текст, и по делу: граница порции режет файл
 * где придётся. Резать она может и посреди многобайтового символа UTF-8,
 * и посреди строки, и между CR и LF. Все три случая здесь и закрыты:
 *
 *  - символы склеивает `StringDecoder`, он держит незавершённые байты у себя;
 *  - незавершённая строка остаётся в хвосте до перевода строки;
 *  - хвост хранится вместе с `\r`, поэтому CRLF, разрезанный пополам,
 *    после склейки снова становится одним переводом строки.
 *
 * Разбиение по `/\r?\n/` — то же, что в пакетном `splitLogLines`: обычные
 * строки клиент завершает CRLF, а баннер обрезки одиночными LF.
 */
export class LineAssembler {
  #decoder = new StringDecoder('utf8');
  #tail = '';

  /** Целые строки из очередной порции. Незавершённая остаётся ждать. */
  push(chunk: Buffer): string[] {
    if (chunk.length === 0) return [];

    const text = this.#tail + this.#decoder.write(chunk);
    const parts = text.split(/\r?\n/);

    // Последний кусок не завершён переводом строки — он ещё не строка.
    this.#tail = parts.pop() ?? '';
    return parts;
  }

  /**
   * Отдать недописанный хвост как строку.
   *
   * Нужно только на конце файла, который больше не растёт: в живом режиме
   * хвост дописывается следующей порцией, и торопиться с ним нельзя.
   */
  flush(): string[] {
    const rest = this.#tail + this.#decoder.end();
    this.#tail = '';
    return rest === '' ? [] : [rest];
  }

  /** Сколько байт-символов ждут своей строки. Для диагностики. */
  get pending(): number {
    return this.#tail.length;
  }

  reset(): void {
    this.#decoder = new StringDecoder('utf8');
    this.#tail = '';
  }
}
