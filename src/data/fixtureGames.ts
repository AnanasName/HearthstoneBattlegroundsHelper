/**
 * Партии ТЕКУЩЕГО билда — один список на всех, кто их читает.
 *
 * Почему отдельным модулем. Список жил семью независимыми литералами
 * (сверка покупок, сверка плана, четыре замера, досбор датасета) и,
 * разумеется, разъехался: `validate`, `validateSpend` и `spike:level`
 * дошли до part26, замеры `buff`/`taunt`/`hand` остались на part21–22,
 * а `dataset:backfill` — на part22, то есть молча не добирал ЧЕТЫРЕ партии
 * текущего билда. Увидеть это по прогону нельзя: каждый скрипт зелен
 * на том подмножестве, которое сам же и перечислил.
 *
 * Граница списка — ПАТЧ (а не номер билда: баланс и багфиксы игру
 * не меняют, см. таблицу совместимости в src/data/builds.ts), а не свежесть: part1–part3 сыграны на прежних
 * правилах, и учиться на них — учиться другой игре. Они остаются проверкой
 * разбора лога, как записано в CLAUDE.md, и сюда не входят намеренно.
 *
 * Замеры, у которых результат ЗАПИСАН в CLAUDE.md как факт (`spike:buff`,
 * `spike:taunt`, `spike:hand`), берут этот же список: замер на подмножестве
 * данных — это замер, который тихо отвечает не на тот вопрос. Цена честная
 * и названа вслух: добавление фикстуры делает записанные числа устаревшими
 * до перезапуска, и перезапускать надо все замеры сразу.
 *
 * 02.09.2026 список расширен с part4–part26 до part4–part35 — девять партий
 * билда 250339 лежали в фикстурах, но ни в одну сверку и ни в один замер
 * не входили (пункт «partN не в CURRENT_BUILD_PARTS» стоял в docs/next-steps.md
 * девять раз подряд). Цена, обещанная выше, уплачена целиком: все замеры
 * перезапущены разом, числа переписаны в docs/quality.md.
 */
import { existsSync, readFileSync } from 'node:fs';

/** Номера партий текущего билда, по возрастанию. */
export const CURRENT_BUILD_PARTS: readonly number[] = [
  4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
  29, 30, 31, 32, 33, 34, 35,
];

/** Путь к логу партии — тот же, что у фикстур в `data/fixtures/`. */
export function fixtureLogPath(part: number): string {
  return `data/fixtures/part${String(part)}/game.log`;
}

/**
 * Файлы партии по порядку. Обычно один `game.log`, но партия с перезапуском
 * клиента лежит СЕГМЕНТАМИ (part1 — четыре, part35 — два), и `game.log`
 * у неё не существует вовсе.
 *
 * Это и есть причина, по которой чтение партии живёт здесь, а не у каждого
 * скрипта своё: пока сегменты знал один `spike:arena`, добавление part35
 * в общий список молча роняло бы остальные семь читателей на `ENOENT`.
 */
export function fixtureLogPaths(part: number): readonly string[] {
  const single = fixtureLogPath(part);
  if (existsSync(single)) return [single];
  const segments: string[] = [];
  for (let n = 1; ; n += 1) {
    const path = `data/fixtures/part${String(part)}/segment${String(n)}.log`;
    if (!existsSync(path)) break;
    segments.push(path);
  }
  return segments;
}

/** Текст всей партии одной строкой; `null`, если лога нет. */
export function readFixtureGame(part: number): string | null {
  const paths = fixtureLogPaths(part);
  if (paths.length === 0) return null;
  return paths.map((p) => readFileSync(p, 'utf8')).join('\n');
}
