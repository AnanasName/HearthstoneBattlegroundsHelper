/**
 * Число со словом в нужном падеже: 1 борд, 3 борда, 52 борда, 11 бордов.
 *
 * Отчёт читает человек, и «52 бордов» или «1 свободн. места» режут глаз
 * сильнее, чем стоит эта функция.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  const word =
    mod100 >= 11 && mod100 <= 14 ? many : mod10 === 1 ? one : mod10 >= 2 && mod10 <= 4 ? few : many;
  return `${String(n)} ${word}`;
}

export const boards = (n: number): string => plural(n, 'борд', 'борда', 'бордов');
export const freeSlots = (n: number): string => plural(n, 'свободное место', 'свободных места', 'свободных мест');
export const clicks = (n: number): string => plural(n, 'нажатие', 'нажатия', 'нажатий');
