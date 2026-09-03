import { beforeAll, describe, expect, it } from "vitest";

import {
  adviseTavern,
  spinRule,
  type Recommendation,
} from "../../src/advisors/tavern/advisor.js";
import { spendPlan } from "../../src/advisors/tavern/spend.js";
import { loadCardIndex, type CardIndex } from "../../src/data/cards.js";
import { readPowerEvents } from "../../src/parser/blocks.js";
import { readPlayers } from "../../src/state/players.js";
import { createReducer } from "../../src/state/reducer.js";
import type { GameState } from "../../src/state/types.js";
import { recommendationLine, spendPlanLine } from "../../src/ui/format.js";
import { part38Game } from "../fixtures.js";
import { changesAdvisorState } from "../snapshots.js";

/**
 * part38 — тридцатая партия с оверлеем (04.09.2026, Генн Седогрив
 * `BG35_HERO_001`, 3-е место), двенадцатая на билде 250339. Два пункта
 * игрока, и они разной природы: первый — СЛЕПОТА советника, второй —
 * повторная жалоба, у которой дефекта нет.
 *
 *  1. **Ход 5.** «Первый предложенный ход выглядит странным. Кажется, что
 *     лучше было купить свинобраза, продать его и купить ещё одно
 *     существо, как я и сделал». Свинобраз — Razorfen Geomancer `BG20_100`
 *     («Battlecry: Get 2 Blood Gems»), и описанная цепочка это ровно
 *     ПРОКРУТКА `spinRule` (part16): купить за 3, разыграть, продать за 1
 *     и на остаток купить тело. Правило молчало, и причина — в чтении
 *     ЧИСЛА: счёт обещанных карт искался только словом
 *     («two»/«three»/«four»), потому что таким его пишет Oozeling
 *     Gladiator, на котором правило и родилось. Снапшот пишет и цифрой,
 *     и тогда счёт падал на умолчание 1 — а с ним собственная ценность
 *     прокрутки выходила РОВНО ноль (1×6 − 2×3) и гасла об условие
 *     `base <= 0`. Тихая потеря целого правила от одной цифры.
 *
 *  2. **Ход 21.** «Снова предлагает обновить без золота»: золото 0/10,
 *     борд полон, обновление бесплатно, совет — «ОБНОВИТЬ — ищем третью
 *     копию Hired Mount». Это правило part27 с целью, названной в строке
 *     после part37, и дефекта в нём не нашлось. Партия подтвердила цель
 *     числами: на ходу 23 игрок прокрутил витрину, купил третью копию
 *     `BG36_240` и собрал золотого Hired Mount 313/197 — крупнейшую карту
 *     своего борда. Тест держит не «совет правильный», а цепочку целиком:
 *     обновление называет цель, найденная копия морозится, а с золотом
 *     покупается, — потому что жалоба игрока была именно на обрыв цепочки
 *     («купить всё равно не на что»), и молча потерять любое её звено
 *     значит вернуть жалобу.
 */
describe("part38: прокрутка генератора со счётом ЦИФРОЙ, цель обновления доводится до конца", () => {
  const RAZORFEN = "BG20_100";
  const METALLIC_HUNTER = "BG32_170";
  const LEAF = "BG28_827";
  const HIRED_MOUNT = "BG36_240";

  let cards: CardIndex;
  /** Ход 5, точка решения: тир 2, золото 5/5, витрина из четырёх. */
  let decision5: GameState | null = null;
  /** Скриншот хода 21: тир 5, золото 0, борд полон, обновление бесплатно. */
  let shot21: GameState | null = null;
  let end: GameState;

  beforeAll(() => {
    cards = loadCardIndex();
    const text = part38Game();
    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      if (!changesAdvisorState(event.line.content)) continue;
      const s = reducer.snapshot();
      if (s.phase !== "tavern") continue;
      if (
        s.turn === 5 &&
        s.goldSpent === 0 &&
        s.gold === 5 &&
        s.shop.length >= 4
      )
        decision5 = s;
      if (
        s.turn === 21 &&
        s.techLevel === 5 &&
        s.gold === 0 &&
        s.board.length === 7
      )
        shot21 = s;
    }
    end = reducer.snapshot();
  }, 900_000);

  const must = (s: GameState | null, what: string): GameState => {
    if (s === null) throw new Error(`не найдено состояние: ${what}`);
    return s;
  };
  const deps = (): { cards: CardIndex } => ({ cards });
  /** Верхний совет: `adviseTavern` вне таверны возвращает `null`. */
  const topAdvice = (s: GameState): Recommendation => {
    const advice = adviseTavern(s, deps());
    const top = advice?.recommendations[0];
    if (top === undefined) throw new Error("советов нет");
    return top;
  };

  it("партия читается целиком: Генн, билд 250339, 3-е место", () => {
    expect(end.phase).toBe("gameOver");
    expect(end.hero?.cardId).toBe("BG35_HERO_001");
    expect(end.buildNumber).toBe(250339);
    expect(end.finalPlace).toBe(3);
  });

  /**
   * Пункт 1, фактура: счёт написан ЦИФРОЙ, и это единственная разница
   * с Oozeling Gladiator, на котором правило работало.
   */
  it("ход 5: свинобраз обещает карты цифрой, а не словом", () => {
    const text = cards.info(RAZORFEN)?.text ?? "";
    expect(text).toMatch(/Get\s+2\b/i);
    expect(text).not.toMatch(/\b(?:two|three|four)\b/i);
    // Пул целиком: словом счёт пишет ровно один генератор, цифрой — тоже
    // один. Числа держатся тестом, потому что в прозе они разъезжаются.
    const generators = [1, 2, 3, 4, 5, 6, 7]
      .flatMap((t) => cards.poolOfTier(t))
      .filter((c) =>
        /battlecry:?[^.]*\b(?:get|discover|add)s?\b/i.test(c.text ?? ""),
      );
    expect(generators).toHaveLength(22);
    expect(
      generators.filter((c) =>
        /\b(?:get|discover|add)s?\s+(?:two|three|four)\b/i.test(c.text ?? ""),
      ),
    ).toHaveLength(1);
    expect(
      generators.filter((c) =>
        /\b(?:get|discover|add)s?\s+\d+\b/i.test(c.text ?? ""),
      ),
    ).toHaveLength(1);
  });

  /**
   * Пункт 1, жалоба. Совет обязан назвать цепочку целиком — и прокрутку,
   * и то, что покупается следом: игрок описал её именно так.
   */
  it("ход 5: верхний совет — прокрутить свинобраза, а не покупать с горящей монетой", () => {
    const s = must(decision5, "точка решения хода 5");
    expect(s.techLevel).toBe(2);
    expect(s.gold).toBe(5);
    expect(s.board).toHaveLength(1);

    const spin = spinRule(s, deps());
    expect(spin?.minion?.cardId).toBe(RAZORFEN);
    // Клич обещает ДВЕ карты: 2×6 − 2×3 = 6 собственных очков.
    expect(spin?.reason).toContain("клич даст 2 карт");
    expect(spin?.cost).toBe(2);

    const top = topAdvice(s);
    expect(top.action).toBe("spin");
    expect(top.minion?.cardId).toBe(RAZORFEN);
    // Цепочка названа до конца: на остаток покупается тело.
    expect(top.reason).toContain("Metallic Hunter");
    expect(recommendationLine(top, cards)).toContain("ПРОКРУТИТЬ");
  });

  /**
   * План хода — дословный ход игрока: прокрутка, потом покупка. Прежде
   * план тратил 4 из 5 и сжигал монету на «Leaf Through the Pages».
   */
  it("ход 5: план хода повторяет сыгранное игроком, и монета не горит", () => {
    const s = must(decision5, "точка решения хода 5");
    const plan = spendPlan(s, deps());
    const steps = plan.steps.map((x) => x.recommendation);
    expect(steps[0]?.action).toBe("spin");
    expect(steps[0]?.minion?.cardId).toBe(RAZORFEN);
    expect(steps[1]?.action).toBe("buy");
    expect(steps[1]?.minion?.cardId).toBe(METALLIC_HUNTER);
    expect(plan.goldLeft).toBe(0);
    expect(spendPlanLine(plan, cards)).not.toContain("сгорит");
    // Заклинание-обновление больше не подбирает остаток: остатка нет.
    expect(steps.map((x) => x.minion?.cardId ?? x.spellCardId)).not.toContain(
      LEAF,
    );
  });

  /**
   * Пункт 2. Дефекта нет — и это записано цепочкой, а не мнением:
   * обновление называет цель, найденная копия морозится, а на золоте
   * покупается. Жалоба была на обрыв цепочки, и обрыв ловится тестом.
   */
  it("ход 21: обновление при нуле золота названо целью, и цель доводится до тройки", () => {
    const s = must(shot21, "скриншот хода 21");
    expect(s.rerollCost).toBe(0);
    expect(s.gold).toBe(0);
    // Две копии: одна на борде, одна в руке — игра считает и руку (part29).
    expect(s.board.filter((m) => m.cardId === HIRED_MOUNT)).toHaveLength(1);
    expect(s.hand.filter((m) => m.cardId === HIRED_MOUNT)).toHaveLength(1);

    const top = topAdvice(s);
    expect(top.action).toBe("reroll");
    expect(top.searchGoal).toContain("третью копию Hired Mount");

    // Звено два: копия НАШЛАСЬ — витрина морозится, хотя золота всё ещё нет.
    const found = s.hand.find((m) => m.cardId === HIRED_MOUNT);
    if (found === undefined) throw new Error("нет копии в руке");
    const third = {
      ...found,
      entityId: 999_001,
      zone: "shop" as const,
      buyCost: 3,
    };
    const withCopy: GameState = { ...s, shop: [...s.shop.slice(0, 3), third] };
    const onFound = topAdvice(withCopy);
    expect(onFound.action).toBe("freeze");
    expect(onFound.minion?.cardId).toBe(HIRED_MOUNT);

    // Звено три: с золотом следующего хода копия ПОКУПАЕТСЯ — тройка.
    const rich = topAdvice({ ...withCopy, gold: 10 });
    expect(rich.action).toBe("buy");
    expect(rich.minion?.cardId).toBe(HIRED_MOUNT);
    expect(rich.reason).toContain("тройку");
  });

  /**
   * Что сделал игрок на самом деле — обе жалобы судятся журналом, а не
   * пересказом. Ход 5: прокрутка дословно. Ход 23: третья копия куплена
   * после обновления, ровно та цель, которую советник назвал на ходу 21.
   */
  it("журнал партии: прокрутка на ходу 5 и третья копия на ходу 23", () => {
    const turn5 = end.actions
      .filter((a) => a.turn === 5)
      .map((a) => `${a.type} ${a.cardId ?? ""}`);
    expect(turn5.slice(0, 5)).toEqual([
      `buy ${RAZORFEN}`,
      `play ${RAZORFEN}`,
      `sell ${RAZORFEN}`,
      `buy ${METALLIC_HUNTER}`,
      `play ${METALLIC_HUNTER}`,
    ]);
    // Два самоцвета из клича — то, ради чего цепочка и затевалась.
    expect(turn5.filter((a) => a === "play BG20_GEM")).toHaveLength(2);

    const turn23 = end.actions.filter((a) => a.turn === 23);
    expect(
      turn23.some((a) => a.type === "buy" && a.cardId === HIRED_MOUNT),
    ).toBe(true);
  });
});
