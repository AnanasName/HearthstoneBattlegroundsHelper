import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern, heroPowerRule } from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { recommendationLine, spendPlanLine } from '../../src/ui/format.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part37Game } from '../fixtures.js';
import { changesAdvisorState } from '../snapshots.js';

/**
 * part37 — двадцать девятая партия с оверлеем (03.09.2026, 21:16–21:41,
 * Алекстраза `TB_BaconShop_HERO_56`, драконы, 2-е место), одиннадцатая
 * на билде 250339. Три пункта игрока по трём скриншотам.
 *
 *  1. **Ход 1 (и ещё четыре хода подряд).** «Предлагает нажать силу героя,
 *     которая открывается только на 4 ходу» — на 4-м ТИРЕ: «Queen of
 *     Dragons» `TB_BaconShop_HP_064` («Discover a Dragon. *(Unlocks
 *     at Tier 4.)*»). Советник ставил её верхней строкой на ходах 1–9
 *     и вписывал в план хода, потому что по всем читаемым признакам она
 *     доступна: `HAS_ACTIVATE_POWER=1`, `COST=1`, а `LITERALLY_UNPLAYABLE`
 *     не приходит НИ РАЗУ. Замок в логе есть, но своим тегом —
 *     `LOCK_VISUAL`.
 *
 *  2. **Ход 9, после подъёма на тир 4.** «Почему предлагает заморозить
 *     заклинание?» — витрину держат ради «Chef's Choice» `BG28_518` за 2,
 *     и это ветка part17 → part27 → part29: заклинание дешевле покупки,
 *     даёт миньона, и на следующем ходу даёт ЛИШНЕЕ тело (8 золота: 2+3+3
 *     против 3+3). Дефекта тут не нашлось, и тест закрепляет условия,
 *     при которых совет звучит, — чтобы будущая правка их не потеряла молча.
 *
 *  3. **Ход 21, после подъёма на тир 5.** «Предлагает обновить таверну,
 *     хотя я всё равно ничего не смогу купить». Правило part27 крутит
 *     витрину при нуле золота только под НАЗВАННУЮ цель заморозки, и цель
 *     была — третья копия Hired Mount под тройку. Но называлась она
 *     в `reason`, которого оверлей не показывает: на экран идёт короткая
 *     строка действия, а у обновления в ней нет ни миньона, ни заклинания.
 *     Игрок видел «ОБНОВИТЬ» и возражал совершенно справедливо — по всему,
 *     что ему показали.
 */
describe('part37: замок силы героя по тиру, цель обновления в строке действия', () => {
  const QUEEN_OF_DRAGONS = 'TB_BaconShop_HP_064';
  const HIRED_MOUNT = 'BG36_240';
  const CHEFS_CHOICE = 'BG28_518';
  const LEAF = 'BG28_827';

  let cards: CardIndex;
  let text: string;
  /** Ход 1, точка решения: тир 1, золото 3/3, витрина из двух миньонов. */
  let decision1: GameState | null = null;
  /** Ход 9, точка решения: тир 3, золото 7/7 — сила ещё под замком. */
  let decision9: GameState | null = null;
  /** Скриншот хода 9: после подъёма на тир 4 — золото 0, витрина доживает. */
  let shot9: GameState | null = null;
  /** Ход 11, точка решения: тир 4 — замок снят. */
  let decision11: GameState | null = null;
  /** Скриншот хода 21: тир 5, золото 0, борд полон, в руке одно заклинание. */
  let shot21: GameState | null = null;
  let end: GameState;

  beforeAll(() => {
    cards = loadCardIndex();
    text = part37Game();
    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      // Замок не входит в общий фильтр: тег `LOCK_VISUAL` встречается
      // в партии единицами строк, и его метку тест объявляет сам.
      if (!changesAdvisorState(event.line.content, ['LOCK_VISUAL'])) continue;
      const s = reducer.snapshot();
      if (s.phase !== 'tavern') continue;
      if (s.turn === 1 && s.goldSpent === 0 && s.gold === 3 && s.shop.length >= 2) decision1 = s;
      if (s.turn === 9 && s.goldSpent === 0 && s.gold === 7 && s.shop.length >= 4) decision9 = s;
      if (s.turn === 9 && s.techLevel === 4 && s.gold === 0 && s.shop.length >= 4) shot9 = s;
      if (s.turn === 11 && s.goldSpent === 0 && s.gold === 8 && s.shop.length >= 4) decision11 = s;
      if (
        shot21 === null &&
        s.turn === 21 &&
        s.techLevel === 5 &&
        s.gold === 0 &&
        s.board.length === 7 &&
        s.handSpells.length === 1 &&
        s.handSpells[0]?.cardId === LEAF
      ) {
        shot21 = s;
      }
    }
    end = reducer.snapshot();
  }, 900_000);

  const must = (s: GameState | null, what: string): GameState => {
    if (s === null) throw new Error(`не найдено состояние: ${what}`);
    return s;
  };
  const deps = (): { cards: CardIndex } => ({ cards });

  it('партия читается целиком: Алекстраза, билд 250339, 2-е место', () => {
    expect(end.phase).toBe('gameOver');
    expect(end.turn).toBe(26);
    expect(end.hero?.cardId).toBe('TB_BaconShop_HERO_56');
    expect(end.hero?.heroPowerCardId).toBe(QUEEN_OF_DRAGONS);
    expect(end.buildNumber).toBe(250339);
    expect(end.playerBattleTag).toBe('AngryMem#2886');
    expect(end.finalPlace).toBe(2);
  });

  /**
   * Пункт 1, фактура. Замок читается ровно одним тегом, и все прочие
   * признаки говорят «сила доступна» — потому дыра и прожила незамеченной.
   */
  it('ход 1: сила под замком, но по прежним признакам неотличима от доступной', () => {
    const s = must(decision1, 'точка решения хода 1');
    const hero = s.hero;
    expect(s.techLevel).toBe(1);
    expect(hero?.heroPowerLocked).toBe(true);
    // Три признака, по которым правила решали «жать можно», — все за.
    expect(hero?.heroPowerHasActivate).toBe(true);
    expect(hero?.heroPowerUnplayable).toBe(false);
    expect(hero?.heroPowerCost).toBe(1);
    // И тег `LITERALLY_UNPLAYABLE` не приходит на неё за всю партию.
    expect(text).not.toMatch(/id=151[^\n]*LITERALLY_UNPLAYABLE/);
    // Замок назван и в тексте карты, и отдельным каналом опций.
    expect(cards.info(QUEEN_OF_DRAGONS)?.text).toMatch(/Unlocks at Tier 4/i);
    expect(text).toContain('REQ_MINIMUM_TAVERN_TIER_LEVEL_TO_PLAY');
  });

  it('ход 1: сила под замком не советуется и в план хода не попадает', () => {
    const s = must(decision1, 'точка решения хода 1');
    expect(heroPowerRule(s, deps())).toBeNull();

    const advice = adviseTavern(s, deps());
    expect(advice?.recommendations.some((r) => r.action === 'heroPower')).toBe(false);
    expect(spendPlanLine(spendPlan(s, deps()), cards)).not.toContain('СИЛА ГЕРОЯ');
  });

  it('ходы 1–9: замок держится, с тира 4 снимается — и совет возвращается сам', () => {
    // Пять точек решения подряд под замком: столько ходов советник
    // и предлагал недоступное действие.
    for (const [turn, s] of [
      [1, decision1],
      [9, decision9],
    ] as const) {
      expect(must(s, `точка решения хода ${String(turn)}`).hero?.heroPowerLocked).toBe(true);
    }

    const s11 = must(decision11, 'точка решения хода 11');
    expect(s11.techLevel).toBe(4);
    expect(s11.hero?.heroPowerLocked).toBe(false);
    // Сила даёт дракона за 1 при цене покупки 3 — верхний совет и первый
    // шаг плана, как и должно быть с тира 4.
    const advice11 = adviseTavern(s11, deps());
    expect(advice11?.recommendations[0]?.action).toBe('heroPower');
    expect(spendPlanLine(spendPlan(s11, deps()), cards)).toContain('СИЛА ГЕРОЯ');
  });

  /**
   * Пункт 2. Совет игрока смутил, но условия ветки в этом состоянии
   * выполняются все: заклинание дешевле покупки, даёт миньона и приносит
   * на следующем ходу лишнее тело. Тест закрепляет именно условия — если
   * ветку будут менять, видно будет, какое из них ушло.
   */
  it('ход 9 после подъёма: витрину держат ради заклинания дешевле покупки', () => {
    const s = must(shot9, 'скриншот хода 9');
    expect(s.techLevel).toBe(4);
    expect(s.gold).toBe(0);
    expect(s.board.length).toBeLessThan(7);

    const spell = s.shopSpells.find((sp) => sp.cardId === CHEFS_CHOICE);
    expect(spell?.cost).toBe(2);
    // Дешевле покупки — строго: вся ветка про то, что заклинание занимает
    // золото, которого на миньона не хватит.
    expect(s.shop.every((m) => (m.buyCost ?? 3) === 3)).toBe(true);

    const advice = adviseTavern(s, deps());
    const freeze = advice?.recommendations.find((r) => r.action === 'freeze');
    expect(freeze?.spellCardId).toBe(CHEFS_CHOICE);
    // Обещание ветки названо словами и проверено счётом (part29): восемь
    // золота следующего хода — это 2+3+3 против 3+3.
    expect(freeze?.reason).toContain('два тела вместо одного');
  });

  /**
   * Пункт 3. Правило было право, а на экране от него не оставалось ничего:
   * `reason` оверлей не показывает.
   */
  it('ход 21: обновление при нуле золота названо целью прямо в строке действия', () => {
    const s = must(shot21, 'скриншот хода 21');
    expect(s.gold).toBe(0);
    expect(s.techLevel).toBe(5);
    expect(s.board.length).toBe(7);
    // Цель реальна: две незолотые копии Hired Mount, тир 3 при таверне 5 —
    // витрина такую карту предложить может.
    const copies = s.board.filter((m) => m.cardId === HIRED_MOUNT && !m.golden);
    expect(copies.length).toBe(2);

    const advice = adviseTavern(s, deps());
    const top = advice?.recommendations[0];
    expect(top?.action).toBe('reroll');
    expect(top?.cost).toBe(0);
    expect(top?.searchGoal).toBe(`третью копию ${cards.info(HIRED_MOUNT)?.name ?? HIRED_MOUNT}`);

    // Строка оверлея — то единственное, что игрок видит.
    const line = recommendationLine(top!, cards);
    expect(line).toContain('ОБНОВИТЬ');
    expect(line).toContain('ищем третью копию Hired Mount');
  });
});
