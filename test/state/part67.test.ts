import { beforeAll, describe, expect, it } from 'vitest';

import {
  adviseTavern,
  battlecryPayoffOf,
  minionValue,
  weakestOwn,
} from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import type { GameState, Minion } from '../../src/state/types.js';
import { frameAt, parseClock, sliceLogByClock } from '../../src/ui/logSlice.js';
import { part67Game } from '../fixtures.js';

/**
 * part67 — 22.09.2026, Вол'джин, 2-е место. Фактура партии — в `test/fixtures.ts`.
 *
 * Жалоба игрока по кадру 19:36 дословно: «предлагает продать полезного
 * мурлока с активацией боевых кличей». Мурлок — Kelp Keeper `BG36_701`,
 * и описание точное: `race: MURLOC`, «Activate ({0}): Trigger a friendly
 * minion's Battlecry».
 *
 * Тест НЕ чинит число, а закрепляет разрыв, на котором оно стоит: плату
 * за нажатие считает D260, но только по каналу D259 («плательщик за
 * РОЗЫГРЫШ племени» при кличевом миньоне, чей текст обещает миньона
 * племени). Плательщик за КЛИЧ (Kalecgos, D224) тем же нажатием платит
 * столько же, читается тем же снапшотом и в ценность нажатия не входит.
 *
 * Запрет продавать носителя активации сюда НЕ возвращается: он отвергнут
 * замером в D184 (469 точек 41 партии, в худшем случае предлагал продать
 * Kalecgos 190/159 ради Hired Mount 40/52). Спор идёт о слагаемом, а не
 * о запрете.
 */
describe('part67: нажатие Kelp Keeper и плательщик за клич', () => {
  let cards: CardIndex;
  let state: GameState;
  let kelp: Minion;

  beforeAll(() => {
    cards = loadCardIndex();
    const clock = parseClock('19:36:30');
    expect(clock).not.toBeNull();
    const slice = sliceLogByClock(part67Game(), clock!);
    expect(slice?.inGame).toBe(true);
    state = frameAt(slice!).state;
    const found = state.board.find((m) => m.cardId === 'BG36_701');
    expect(found).toBeDefined();
    kelp = found!;
  }, 600_000);

  it('кадр воспроизводится: ход таверны 10, золото потрачено, Kelp и Kalecgos на борде', () => {
    // Числа с картинки игрока: тир 5, золото 0 из 10, борд полон.
    expect(state.techLevel).toBe(5);
    expect(state.gold).toBe(0);
    expect(state.board.length).toBe(DEFAULT_TAVERN_RULES.boardSize);
    // Мурлок — как и сказал игрок; тело на кадре 9/9.
    expect(cards.info(kelp.cardId)?.races).toContain('MURLOC');
    expect(kelp.attack).toBe(9);
    expect(kelp.health).toBe(9);
    // Нажатие у него есть и по цене доступно — молчание не от цены.
    expect(kelp.tags['HAS_ACTIVATE_POWER']).toBeGreaterThan(0);
    // Плательщик за клич стоит рядом: повтор клича платит ИМЕННО через него.
    expect(state.board.some((m) => m.cardId === 'BGS_041')).toBe(true);
  });

  it('плательщик за клич на этом борде ЧИТАЕТСЯ — слепота не в снапшоте', () => {
    // Тот же борд, та же таблица правил: Kalecgos опознан как плательщик
    // за клич (D224). Значит фактура на руках, и вопрос только в том,
    // кто ею пользуется.
    const payoff = battlecryPayoffOf(state.board, cards, DEFAULT_TAVERN_RULES);
    expect(payoff).not.toBeNull();
    expect(payoff!.payers.join(' ')).toMatch(/Kalecgos/);
  });

  it('ценность нажатия при этом ноль, и Kelp — слабейший свой', () => {
    // Слагаемое `activation` у носителя повтора клича: статов в тексте нет,
    // а канал D259 молчит — кличевого «Get a random <Tribe>» на борде нет.
    expect(minionValue(kelp, state, { cards }).activation).toBe(0);

    // Следствие: тело считается голым 9/9 и выбирается в жертву продажи.
    const victim = weakestOwn(state, { cards }, DEFAULT_TAVERN_RULES);
    expect(victim).not.toBeNull();
    expect(victim!.minion.cardId).toBe('BG36_701');
  });

  it('план на кадре продаёт Kelp Keeper — ровно то, на что указал игрок', () => {
    const plan = spendPlan(state, { cards });
    const sellsKelp = plan.steps.some(
      (s) => s.recommendation.sellFirst?.cardId === 'BG36_701',
    );
    expect(sellsKelp).toBe(true);
  });
});

/**
 * Жалоба по кадру 19:46 дословно: «рекомендует купить заклинание,
 * от которого неясен практический эффект».
 *
 * Eonar's Favor `BG35_912` — «Choose a minion. Give minions of its type
 * in the Tavern +{0}/+{1} this game»; на кадре 16/14 (базовые 3/3 плюс
 * надбавка таверным заклинаниям). Советник дал ей 81.5 и первый пункт
 * плана. Число раскладывается целиком:
 *
 *   30 статов × 5.83 тела × 0.5 − 2 золота × 3 = 81.5,
 *   где 5.83 = min(remainingTavernBuys[14] = 8.3, boardSize = 7) × 5/6.
 *
 * То есть счёт тел упирается в ПОТОЛОК В СЕМЬ МЕСТ, а не в горизонт партии,
 * — и протухшие таблицы горизонта (22.09) на это число не влияют вовсе.
 * Тест закрепляет обе половины: и что потолок именно там, и что усиленное
 * тело жильцом этого борда не станет.
 */
describe('part67: витринный бафф на 14-м ходу таверны', () => {
  let cards: CardIndex;
  let state: GameState;

  beforeAll(() => {
    cards = loadCardIndex();
    const clock = parseClock('19:46:20');
    expect(clock).not.toBeNull();
    const slice = sliceLogByClock(part67Game(), clock!);
    expect(slice?.inGame).toBe(true);
    state = frameAt(slice!).state;
  }, 600_000);

  it('кадр воспроизводится: тир 5, золото 3, Eonar’s Favor в витрине за 2', () => {
    expect(state.techLevel).toBe(5);
    expect(state.gold).toBe(3);
    const favor = state.shopSpells.find((s) => s.cardId === 'BG35_912');
    expect(favor).toBeDefined();
    expect(favor!.cost).toBe(2);
    // Откуда на кадре 16/14 вместо базовых 3/3: надбавка таверным
    // заклинаниям, +13/+11 — она и стоит во всплывающей подсказке игрока.
    expect(state.globalInfo.tavernSpellAttackBuff).toBe(13);
    expect(state.globalInfo.tavernSpellHealthBuff).toBe(11);
    // Плейсхолдеры живой сущности витрины приходят УЖЕ с надбавкой: базовые
    // 3/3 снапшота игра заменила на 16/14 — ровно то, что игрок видел
    // на карте. Отсюда и «+30 статов» в причине совета.
    expect(favor!.scriptData.slice(0, 2)).toEqual([16, 14]);
  });

  it('советник ставит её первой и дороже всего прочего в витрине', () => {
    const advice = adviseTavern(state, { cards });
    const top = (advice?.recommendations ?? [])[0];
    expect(top).toBeDefined();
    expect(top!.spellCardId).toBe('BG35_912');
    // Число велико не в шуме: следующий совет беднее в разы.
    const next = (advice?.recommendations ?? [])[1];
    expect(top!.score).toBeGreaterThan(next!.score * 3);
  });

  it('счёт тел упирается в размер борда, а НЕ в горизонт партии', () => {
    // Ход таверны 14 — индекс 13. Остаток покупок по таблице больше семи,
    // значит `min(...)` берёт потолок мест, и обновление таблицы горизонта
    // это число не двигает.
    const buys = DEFAULT_TAVERN_RULES.remainingTavernBuys[13]!;
    expect(buys).toBeGreaterThan(DEFAULT_TAVERN_RULES.boardSize);
  });

  it('усиленное тело слабее слабейшего своего — жильцом оно не станет', () => {
    // Тело тира 5 с прибавкой 16/14 — это около 21/19. Слабейший свой
    // на этом кадре стоит несопоставимо дороже, то есть ни одно из 5.8
    // «будущих тел» места на борде не получит.
    const victim = weakestOwn(state, { cards }, DEFAULT_TAVERN_RULES);
    expect(victim).not.toBeNull();
    const buffedBodyStats = 5 + 5 + 16 + 14;
    const weakestStats = (victim!.minion.attack ?? 0) + (victim!.minion.health ?? 0);
    expect(weakestStats).toBeGreaterThan(buffedBodyStats);
  });
});
