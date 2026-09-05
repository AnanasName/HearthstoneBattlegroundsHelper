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
 * Центры карт, снятые с кадра глазами (пиксели изображения).
 *
 * Точность здесь глазомерная — десяток пикселей на кадре шириной 2553, —
 * и этого достаточно: проверяется попадание в слот, а не совпадение до
 * пикселя. Слот шириной около 180 пикселей прощает такую погрешность,
 * а промах моделью мимо ряда — нет.
 */
const MEASURED = {
  shop: { y: 568, xs: [842, 1047, 1264, 1468, 1672] },
  board: { y: 862, xs: [645, 849, 1059, 1270, 1481, 1685, 1889] },
};

/** Кадр лавки аксессуаров: присланный игроком снимок part41, ход 17. */
const TRINKET_SHOT = { w: 2559, h: 1599 };

/**
 * Центры четырёх вариантов лавки, снятые с того кадра.
 *
 * Точность здесь ХУЖЕ, чем у рядов стола, и это надо знать: кадра нет
 * в `data/screenshots/`, он пришёл картинкой в переписке, и центры сняты
 * по ней глазом с пересчётом масштаба. Проверка потому и не «до пикселя»,
 * а «точка внутри слота»: карта лавки шириной около 270 пикселей прощает
 * промах в пару десятков, а промах мимо карты — нет. Составы с двумя
 * и тремя вариантами не проверены вовсе — таких кадров у нас нет.
 */
const MEASURED_TRINKET = { y: 725, xs: [761, 1088, 1414, 1740] };

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
});
