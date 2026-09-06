import { describe, expect, it } from 'vitest';

import { buttonRect, slotRect, type Rect } from '../../src/overlay/layout.js';

/**
 * Геометрия раскладки карт.
 *
 * Главный тест здесь — не свойства формулы, а СВЕРКА С КАДРОМ: центры карт,
 * снятые с настоящего скриншота, обязаны попадать внутрь посчитанных слотов.
 * Без него модель осталась бы красивой арифметикой, ни к чему не привязанной.
 */

/** Кадр `data/screenshots/seventh_turn.png`. */
const SHOT = { w: 2553, h: 1599 };
const ASPECT = SHOT.w / SHOT.h;

/**
 * Центры карт, снятые с кадра (пиксели изображения).
 *
 * Витрина перемерена 05.09 ЯКОРЕМ, а не глазом: розовый медальон тира
 * ловится маской по цвету, и его центры дают ряд 859, 1066, 1273, 1481,
 * 1688 (третий восстановлен по шагу — на кадре он частично перекрыт
 * соседним артом). Вертикаль карты витрины — 503..704, то есть центр 603:
 * медальон стоит НАД картой, на 459..508, и в карту не входит.
 *
 * Борд снят глазами по той же сетке; точность там десяток пикселей,
 * и этого хватает — слот шириной около 170 пикселей прощает такую
 * погрешность, а промах моделью мимо ряда нет.
 */
const MEASURED = {
  shop: { y: 603, xs: [859, 1066, 1273, 1481, 1688] },
  board: { y: 877, xs: [645, 849, 1059, 1270, 1481, 1685, 1889] },
};

/** Медальон тира на кадре: стоит НАД картой витрины и картой не является. */
const TIER_MEDALLION = { top: 459, bottom: 508 };

/** Кадр лавки аксессуаров: присланный игроком снимок part41, ход 17. */
const TRINKET_SHOT = { w: 2559, h: 1599 };

/**
 * Центры четырёх вариантов лавки, снятые с того кадра.
 *
 * Точность здесь ХУЖЕ, чем у рядов стола, и это надо знать: кадра нет
 * в `data/screenshots/`, он пришёл картинкой в переписке, и центры сняты
 * по ней глазом с пересчётом масштаба. Составы с двумя и тремя вариантами
 * не проверены вовсе — таких кадров у нас нет.
 *
 * Числа перемерены по ВТОРОМУ присланному кадру (part42): первый глазомер
 * дал шаг 326 пикселей там, где он 402, и кольцо первого варианта уехало
 * на полкарты вправо. Мерить по кадру, на котором уже нарисовано кольцо,
 * оказалось точнее, чем по чистому: видно не только карту, но и промах.
 */
const MEASURED_TRINKET = { y: 723, xs: [669, 1071, 1473, 1874] };

/** Прямоугольник в долях окна — в пиксели кадра. */
function px(rect: Rect): { x: number; y: number; w: number; h: number } {
  return { x: rect.x * SHOT.w, y: rect.y * SHOT.h, w: rect.w * SHOT.w, h: rect.h * SHOT.h };
}

function contains(rect: Rect, x: number, y: number): boolean {
  const r = px(rect);
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

const centerX = (rect: Rect): number => rect.x + rect.w / 2;

describe('раскладка карт на экране', () => {
  it('слоты витрины накрывают карты, снятые с кадра', () => {
    const { xs, y } = MEASURED.shop;
    for (const [i, x] of xs.entries()) {
      const rect = slotRect('shop', i, xs.length, ASPECT);
      expect(rect, `слот витрины ${String(i)}`).not.toBeNull();
      expect(contains(rect!, x, y), `витрина ${String(i)} в (${String(x)}, ${String(y)})`).toBe(
        true,
      );
    }
  });

  it('слоты борда накрывают карты, снятые с кадра', () => {
    const { xs, y } = MEASURED.board;
    for (const [i, x] of xs.entries()) {
      const rect = slotRect('board', i, xs.length, ASPECT);
      expect(rect, `слот борда ${String(i)}`).not.toBeNull();
      expect(contains(rect!, x, y), `борд ${String(i)} в (${String(x)}, ${String(y)})`).toBe(true);
    }
  });

  it('слоты лавки аксессуаров накрывают варианты, снятые с кадра', () => {
    const { xs, y } = MEASURED_TRINKET;
    const aspect = TRINKET_SHOT.w / TRINKET_SHOT.h;
    for (const [i, x] of xs.entries()) {
      const rect = slotRect('trinket', i, xs.length, aspect);
      expect(rect, `слот лавки ${String(i)}`).not.toBeNull();
      const r = {
        x: rect!.x * TRINKET_SHOT.w,
        y: rect!.y * TRINKET_SHOT.h,
        w: rect!.w * TRINKET_SHOT.w,
        h: rect!.h * TRINKET_SHOT.h,
      };
      expect(
        x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h,
        `лавка ${String(i)} в (${String(x)}, ${String(y)})`,
      ).toBe(true);
    }
  });

  /**
   * Попадания точки в слот МАЛО, и это стоило жалобы игрока (part42).
   *
   * Прежний слот витрины был на 40 пикселей выше карты и на 40 пикселей
   * выше ростом — он захватывал медальон тира, — а тест проходил: центр
   * карты всё равно оказывался внутри такого слота. Значит проверять надо
   * не «накрывает», а СОВПАДАЕТ: кольцо рисуется по слоту, и игрок видит
   * именно его центр.
   */
  it('центр слота совпадает с центром карты, а не просто накрывает её', () => {
    const shop = MEASURED.shop;
    for (const [i, x] of shop.xs.entries()) {
      const r = px(slotRect('shop', i, shop.xs.length, ASPECT)!);
      expect(Math.abs(r.x + r.w / 2 - x), `витрина ${String(i)} по x`).toBeLessThan(15);
      expect(Math.abs(r.y + r.h / 2 - shop.y), `витрина ${String(i)} по y`).toBeLessThan(15);
    }

    const board = MEASURED.board;
    for (const [i, x] of board.xs.entries()) {
      const r = px(slotRect('board', i, board.xs.length, ASPECT)!);
      expect(Math.abs(r.x + r.w / 2 - x), `борд ${String(i)} по x`).toBeLessThan(15);
      expect(Math.abs(r.y + r.h / 2 - board.y), `борд ${String(i)} по y`).toBeLessThan(15);
    }
  });

  it('слот витрины не захватывает медальон тира — он стоит НАД картой', () => {
    // Тот самый дефект: медальон держится на 459..508 всех пяти кадров,
    // а слот начинался на 464 — то есть кольцо обводило значок, а не карту.
    // Допуск в 10 пикселей оставлен потому, что медальон висит ПОВЕРХ
    // верхней кромки рамки и на несколько пикселей её перекрывает.
    const top = px(slotRect('shop', 0, 5, ASPECT)!).y;
    expect(top).toBeGreaterThan(TIER_MEDALLION.bottom - 10);
  });

  it('центры слотов лавки совпадают с вариантами на кадре', () => {
    const { xs, y } = MEASURED_TRINKET;
    const aspect = TRINKET_SHOT.w / TRINKET_SHOT.h;
    for (const [i, x] of xs.entries()) {
      const rect = slotRect('trinket', i, xs.length, aspect)!;
      const cx = (rect.x + rect.w / 2) * TRINKET_SHOT.w;
      const cy = (rect.y + rect.h / 2) * TRINKET_SHOT.h;
      // Допуск втрое шире, чем у рядов стола: замер глазомерный (кадра нет
      // в `data/screenshots/`), и обещать пиксель здесь было бы неправдой.
      expect(Math.abs(cx - x), `лавка ${String(i)} по x`).toBeLessThan(45);
      expect(Math.abs(cy - y), `лавка ${String(i)} по y`).toBeLessThan(45);
    }
  });

  it('карты лавки крупнее карт витрины — это разные ряды, а не один', () => {
    // Если однажды кто-то решит рисовать лавку слотами витрины, тест
    // упадёт: на кадре карта лавки почти вдвое выше карты магазина.
    const trinket = slotRect('trinket', 0, 4, ASPECT);
    const shop = slotRect('shop', 0, 4, ASPECT);
    expect(trinket!.h).toBeGreaterThan(shop!.h * 1.5);
  });

  it('ряд центрируется: у нечётного числа карт средняя стоит по центру стола', () => {
    // Именно это свойство и делает модель переносимой между составами:
    // калибровка снята на пяти и семи картах, а работает на трёх и четырёх.
    const middle = slotRect('board', 2, 5, ASPECT);
    expect(centerX(middle!)).toBeCloseTo(0.498, 3);

    const single = slotRect('shop', 0, 1, ASPECT);
    expect(centerX(single!)).toBeCloseTo(0.498, 3);
  });

  it('ряд симметричен относительно центра при любом составе', () => {
    for (const count of [2, 3, 4, 5, 6, 7]) {
      const first = slotRect('board', 0, count, ASPECT);
      const last = slotRect('board', count - 1, count, ASPECT);
      const mid = (centerX(first!) + centerX(last!)) / 2;
      expect(mid, `состав ${String(count)}`).toBeCloseTo(0.498, 6);
    }
  });

  it('шаг постоянен и не зависит от числа карт', () => {
    // Игра не ужимает ряд при росте состава — она его расширяет. Если это
    // когда-нибудь изменится, тест упадёт, и модель будет пересмотрена,
    // а не унаследована молча.
    const step = (count: number): number =>
      centerX(slotRect('board', 1, count, ASPECT)!) - centerX(slotRect('board', 0, count, ASPECT)!);
    expect(step(7)).toBeCloseTo(step(2), 6);
  });

  it('длины меряются высотой: на широком экране доля ширины меньше', () => {
    // Hearthstone масштабирует стол по высоте. Значит на 21:9 тот же слот
    // занимает меньшую долю ШИРИНЫ, а вертикаль не меняется вовсе.
    const wide = slotRect('board', 0, 7, 21 / 9);
    const narrow = slotRect('board', 0, 7, 4 / 3);
    expect(wide!.w).toBeLessThan(narrow!.w);
    expect(wide!.y).toBeCloseTo(narrow!.y, 6);
    expect(wide!.h).toBeCloseTo(narrow!.h, 6);
  });

  it('слота вне ряда не существует, и это не нулевой прямоугольник', () => {
    // «Карты там нет» и «карта размером ноль» — разные вещи: вторая
    // нарисовалась бы точкой в углу стола.
    expect(slotRect('board', 0, 0, ASPECT)).toBeNull();
    expect(slotRect('board', 7, 7, ASPECT)).toBeNull();
    expect(slotRect('board', -1, 3, ASPECT)).toBeNull();
  });

  it('кнопки таверны стоят по сторонам от центра и выше рядов', () => {
    const levelUp = buttonRect('levelUp', ASPECT);
    const refresh = buttonRect('refresh', ASPECT);
    const freeze = buttonRect('freeze', ASPECT);

    expect(centerX(levelUp)).toBeLessThan(0.498);
    expect(centerX(refresh)).toBeGreaterThan(0.498);
    expect(centerX(freeze)).toBeGreaterThan(centerX(refresh));
    // Кнопки лежат над витриной — иначе метка на подъёме села бы на карты.
    expect(levelUp.y + levelUp.h).toBeLessThan(slotRect('shop', 0, 3, ASPECT)!.y);
  });

  /**
   * Сила героя и тёмный дар — сверка с кадром, как у рядов стола.
   *
   * Кадр `data/screenshots/dark_gift_and_hero_ability.png` (part37, ход 9)
   * прислан игроком ровно ради этого замера: до него у обеих кнопок
   * не было координат вовсе. Числа сняты по кадру 2559×1599 — обод силы
   * 1442..1646 по горизонтали и 1141..1337 по вертикали, обод дара
   * 2165..2312 и 392..517.
   */
  const GIFT_SHOT = { w: 2559, h: 1599 };
  const GIFT_ASPECT = GIFT_SHOT.w / GIFT_SHOT.h;
  const MEASURED_BUTTONS = {
    // Центр силы взят по деревянному ободу; зелёный диск внутри него —
    // 1480..1610 / 1168..1293, и он служит вторым, независимым якорем.
    heroPower: { x: 1544, y: 1239, glow: { x0: 1480, x1: 1610, y0: 1168, y1: 1293 } },
    darkGift: { x: 2238, y: 455 },
  };

  it('центры силы героя и тёмного дара совпадают с кнопками на кадре', () => {
    const at = (name: 'heroPower' | 'darkGift') => {
      const r = buttonRect(name, GIFT_ASPECT);
      return { cx: (r.x + r.w / 2) * GIFT_SHOT.w, cy: (r.y + r.h / 2) * GIFT_SHOT.h, r };
    };
    for (const name of ['heroPower', 'darkGift'] as const) {
      const { cx, cy } = at(name);
      const m = MEASURED_BUTTONS[name];
      // Тот же допуск, что у рядов стола: замер пиксельный, а не глазомерный.
      expect(Math.abs(cx - m.x), `${name} по x`).toBeLessThan(15);
      expect(Math.abs(cy - m.y), `${name} по y`).toBeLessThan(15);
    }
  });

  it('слот силы героя накрывает светящийся диск и не берёт монету цены', () => {
    // Монета цены стоит НАД кнопкой — как медальон тира над картой витрины
    // (part42): её низ на кадре 1145, и слот, начинающийся выше, обводил бы
    // цену вместе с кнопкой. Диск же обязан войти целиком — он и есть
    // то, на что игрок смотрит.
    const r = buttonRect('heroPower', GIFT_ASPECT);
    const box = {
      x0: r.x * GIFT_SHOT.w,
      x1: (r.x + r.w) * GIFT_SHOT.w,
      y0: r.y * GIFT_SHOT.h,
      y1: (r.y + r.h) * GIFT_SHOT.h,
    };
    const glow = MEASURED_BUTTONS.heroPower.glow;
    expect(box.x0).toBeLessThan(glow.x0);
    expect(box.x1).toBeGreaterThan(glow.x1);
    expect(box.y0).toBeLessThan(glow.y0);
    expect(box.y1).toBeGreaterThan(glow.y1);
  });

  it('сила героя стоит НИЖЕ рядов стола, а тёмный дар — правее и выше их', () => {
    // Свойства, за которые держится смысл: сила — у портрета героя внизу,
    // дар — на правой стене над таймером. Перепутать их местами формула
    // не может молча.
    const power = buttonRect('heroPower', GIFT_ASPECT);
    const gift = buttonRect('darkGift', GIFT_ASPECT);
    const board = slotRect('board', 6, 7, GIFT_ASPECT)!;
    expect(power.y).toBeGreaterThan(board.y + board.h);
    expect(centerX(power)).toBeGreaterThan(0.498);
    expect(gift.x).toBeGreaterThan(board.x + board.w);
    expect(gift.y + gift.h).toBeLessThan(board.y);
    // По высоте дар заходит на полосу витрины, и это не ошибка: он на СТЕНЕ,
    // а не на столе, и от крайней карты витрины его отделяет ширина стола.
    expect(gift.x).toBeGreaterThan(slotRect('shop', 4, 5, GIFT_ASPECT)!.x);
  });
});
