import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern } from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer, reduceLog } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { recommendationLine, spendPlanLine } from '../../src/ui/format.js';
import { createBreather } from '../breather.js';
import { part52Game } from '../fixtures.js';

/**
 * part52 — Суперзлодей Рафаам (16.09.2026), мехи на магнитах, 3-е место.
 *
 * Фактура партии — в `test/fixtures.ts`. Здесь держатся два факта формата
 * лога, найденные разбором этой партии, и оба давали НЕ падение, а тихо
 * неверный результат.
 */
describe('part52: реванш и порядок строк про героя соперника', () => {
  let text: string;
  let cards: CardIndex;
  let turns: TavernTurn[];
  let final: GameState;

  // Лог 39 МБ: без пауз разбор держит поток воркера дольше тайм-аута RPC.
  beforeAll(async () => {
    text = part52Game();
    cards = loadCardIndex();
    turns = await readTavernTurnsAsync(text, createBreather());
    const reducer = createReducer(readPlayers(text));
    const breather = createBreather();
    for (const event of readPowerEvents(text)) {
      if (breather.due()) await breather.pause();
      reducer.step(event);
    }
    final = reducer.snapshot();
  }, 600_000);

  it('партия целая: один матч Battlegrounds, доигранный до конца', () => {
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.match(/GameState\.DebugPrintPower\(\) - CREATE_GAME/g)).toHaveLength(1);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
    expect(final.buildNumber).toBe(251952);
    expect(final.finalPlace).toBe(3);
    expect(turns).toHaveLength(13);
  });

  /**
   * В обычном бою `PLAYER_ID` героя приходит РАНЬШЕ, чем слот соперника
   * получает `HERO_ENTITY`, и владелец находится сразу. В реванше порядок
   * обратный — таких боёв в партии два из тринадцати:
   *
   *   D 00:50:14.2456984 … TAG_CHANGE Entity=Бармен Боб tag=HERO_ENTITY value=9565
   *   D 00:50:14.2456984 … TAG_CHANGE Entity=9565 tag=PLAYER_ID value=7
   *
   *   D 00:58:00.1154779 … TAG_CHANGE Entity=Бармен Боб tag=HERO_ENTITY value=16024
   *   D 00:58:00.1154779 … TAG_CHANGE Entity=16024 tag=PLAYER_ID value=4
   *
   * Для сравнения, бой хода 2 — порядок обычный:
   *
   *   D 00:37:08.9474589 … TAG_CHANGE Entity=554 tag=PLAYER_ID value=3
   *   D 00:37:08.9474589 … TAG_CHANGE Entity=Dumdidum tag=HERO_ENTITY value=554
   */
  it('в логе есть оба порядка строк: обычный бой и реванш', () => {
    const rematch = /TAG_CHANGE Entity=Бармен Боб tag=HERO_ENTITY value=(\d+) \r?\n[^\n]*TAG_CHANGE Entity=\1 tag=PLAYER_ID value=(\d+)/g;
    const found = [...text.matchAll(rematch)].map((m) => `${m[1] ?? ''}:${m[2] ?? ''}`);
    expect(found).toEqual(['9565:7', '16024:4']);
    expect(text).toContain('TAG_CHANGE Entity=554 tag=PLAYER_ID value=3');
  });

  /**
   * Соперники по ходам боёв, снятые со строк лога:
   * 2→3, 4→4, 6→8, 8→6, 10→5, 12→2, 14→7, 16→6, 18→7, 20→4, 22→2, 24→4, 26→5.
   * Последний увиденный борд каждого — с его ПОСЛЕДНЕГО боя.
   */
  it('борд соперника достаётся тому, с кем дерёмся, и в реванше тоже', () => {
    expect(final.lastSeenBoardTurns[7]).toBe(18);
    expect(final.lastSeenBoardTurns[4]).toBe(24);
    expect(final.lastSeenBoardTurns[2]).toBe(22);
    expect(final.lastSeenBoardTurns[6]).toBe(16);
    expect(final.lastSeenBoardTurns[3]).toBe(2);
    expect(final.lastSeenBoardTurns[8]).toBe(6);
  });

  /**
   * Тег `NEXT_OPPONENT_PLAYER_ID` называет того же игрока, что и разбор боя:
   * в таверне хода 23 игра обещает игрока 4, и бой хода 24 идёт с ним.
   *
   *   D 00:55:29.8326404 … tag=NEXT_OPPONENT_PLAYER_ID value=4
   */
  it('обещанный соперник совпадает с тем, чей борд снят в бою', () => {
    const before = turns.find((t) => t.turn === 23);
    expect(before?.state.nextOpponentPlayerId).toBe(4);
    expect(final.lastSeenBoardTurns[4]).toBe(24);
  });

  const decisionPoint = (turn: number): GameState => {
    const found = turns.find((t) => t.turn === turn);
    expect(found, `точка решения хода ${String(turn)}`).toBeDefined();
    return found!.state;
  };

  /** Состояние на момент времени — срезом лога (метод part40, part43–part51). */
  const at = (until: string): GameState => {
    const lines: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^D (\d\d:\d\d:\d\d)/.exec(line);
      if (m !== null && (m[1] ?? '') > until) break;
      lines.push(line);
    }
    return reduceLog(lines.join('\n'));
  };

  /**
   * Ход 23: hp 1, золото 10, все шаги плана бесплатны (голем и Eonar's Favor
   * из руки, магнит), кроме Careful Investment за 1. Подъём обнулён порогом
   * здоровья, и план печатал «остаётся 10 — сгорит». Игрок поднялся до 6:
   *
   *   D 00:56:26.7696895 … BLOCK_START BlockType=PLAY Entity=[entityName=Таверна
   *   6-го уровня … cardId=TB_BaconShopTechUp06_Button player=1]
   */
  it('ход 23: золото, которому нет другой траты, уходит в подъём, а не сгорает', () => {
    const state = decisionPoint(23);
    expect(state.gold).toBe(10);
    expect(state.techLevel).toBe(5);
    expect(state.tavernUpgradeCost).toBe(8);
    // Живое здоровье — тег HEALTH минус урон плюс броня: 30 − 29 = 1.
    expect((state.hero?.health ?? 0) - (state.hero?.damage ?? 0) + (state.hero?.armor ?? 0)).toBe(1);

    const level = adviseTavern(state, { cards })?.recommendations.find(
      (r) => r.action === 'levelUp',
    );
    // В СПИСКЕ порог по-прежнему держит подъём на нуле: там он соревнуется
    // с покупками. Ноль теперь помечен своей природой.
    expect(level?.score).toBe(0);
    expect(level?.blockedByHp).toBe(true);

    const plan = spendPlan(state, { cards });
    const actions = plan.steps.map((s) => s.recommendation.action);
    expect(actions).toContain('levelUp');
    // Подъём стоит ПОСЛЕ трат, а не вместо них: покупок он не вытесняет.
    expect(actions.indexOf('levelUp')).toBeGreaterThan(actions.indexOf('buy'));
    expect(plan.goldLeft).toBeLessThanOrEqual(1);
    // Строка шага объясняет себя: в списке тот же подъём стоит с нулём
    // и запретом, и без этих слов план противоречил бы списку на экране.
    const step = plan.steps.find((s) => s.recommendation.action === 'levelUp');
    expect(recommendationLine(step!.recommendation, cards)).toContain('иначе золото сгорает');
    expect(text).toContain('cardId=TB_BaconShopTechUp06_Button player=1');
  });

  /**
   * Ход 21: тот же порог здоровья (hp 11), но тратить ЕСТЬ на что — тёмный
   * дар за 3 (19.3). Хвост не должен вытеснять настоящие траты: корпусный
   * прогон поймал ровно это, когда хвост уменьшал «сгоревшее» золото
   * и тем самым выключал развилку плана.
   */
  it('ход 21: подъём-хвост не вытесняет тёмный дар', () => {
    const state = decisionPoint(21);
    expect(state.gold).toBe(12);
    const plan = spendPlan(state, { cards });
    const actions = plan.steps.map((s) => s.recommendation.action);
    expect(actions).toContain('darkGift');
    expect(actions).not.toContain('levelUp');
  });

  /**
   * Ход 21: сила Рафаама «Мне это нужно!» `TB_BaconShop_HP_053` («Next
   * combat, get a plain copy of the first minion you kill») на ПОЛНОМ борде.
   *
   * Правило силы вычитало ценность жертвы продажи — по фактуре part31/part40,
   * где найденный миньон приходит в руку СЕЙЧАС. Здесь он приходит на конце
   * следующего боя, и слот нужен не сейчас; вычет же брал КРУПНЕЙШУЮ карту
   * борда (Cord Puller 76/91) и гасил совет целиком. Молчание выходило ровно
   * на двух ходах партии — 21 и 23, — обоих с полным развитым бордом.
   * Игрок нажал силу на обоих (00:53:39 и 00:56:52).
   */
  it('ход 21: отложенная награда не платит за слот на полном борде', () => {
    const state = decisionPoint(21);
    expect(state.board).toHaveLength(7);
    expect(state.hero?.heroPowerCardId).toBe('TB_BaconShop_HP_053');
    expect(state.hero?.heroPowerCost).toBe(1);

    const power = adviseTavern(state, { cards })?.recommendations.find(
      (r) => r.action === 'heroPower',
    );
    expect(power).toBeDefined();
    // Ни продажи, ни слота: и то и другое было бы платой за место, которое
    // к приходу карты освободит сам бой.
    expect(power?.sellFirst).toBeNull();
    expect(power?.requiresSlot).toBe(false);
    expect(power?.reason).toContain('слот сейчас не нужен');

    expect(spendPlan(state, { cards }).steps.some((s) => s.recommendation.action === 'heroPower')).toBe(
      true,
    );
  });

  /**
   * Ход 3: витрина заморожена ИГРОКОМ (00:37:34), советник о заморозке
   * молчит — и это не дыра, а замеренное «разницы нет» (docs/tavern.md).
   * Тест держит нынешнее поведение: правило заморозки ради заклинания
   * судит ЦЕНОЙ и только заклинание, дающее ТЕЛО (D039).
   */
  it('ход 3: заморозка ради дешёвого баффа не советуется (D039 не переоткрыт)', () => {
    const frame = at('00:37:33');
    expect(frame.gold).toBe(0);
    expect(frame.shopSpells.map((s) => s.cardId)).toEqual(['BG28_503']);
    const advice = adviseTavern(frame, { cards });
    expect(advice?.recommendations.map((r) => r.action)).not.toContain('freeze');
  });

  /**
   * Ход 15: игрок обновил витрину (00:46:17) и купил Weapons Forge за 2
   * (00:46:21), потом разыграл её и положил три стрелы на Ancestral
   * Automaton (00:46:59–00:47:03). Советник карту не видел вовсе: «Get 3
   * Pointy Arrows» — ни статов, ни золота, ни миньона.
   */
  it('ходы 15 и 17: «Get 3 Pointy Arrows» советуется и в витрине, и из руки', () => {
    const shop = at('00:46:20');
    const forge = shop.shopSpells.find((s) => s.cardId === 'BG36_884');
    expect(forge?.cost).toBe(2);
    const buy = adviseTavern(shop, { cards })?.recommendations.find(
      (r) => r.action === 'buy' && r.spellCardId === 'BG36_884',
    );
    // Цена — статы самой стрелы: база снапшота 4/0 плюс живая надбавка
    // заклинаниям таверны (здесь 2/2) — это 8 статов на стрелу, 24 на три,
    // минус два золота: 24 × 0.5 − 2 × 3 = 6.
    expect(shop.globalInfo.tavernSpellAttackBuff).toBe(2);
    expect(buy?.score).toBe(6);
    expect(buy?.reason).toContain('Pointy Arrow');
    expect(spendPlan(shop, { cards }).steps.some((s) => s.recommendation.spellCardId === 'BG36_884')).toBe(true);

    const hand = at('00:46:35');
    expect(hand.handSpells.map((s) => s.cardId)).toContain('BG36_884');
    const play = adviseTavern(hand, { cards })?.recommendations.find(
      (r) => r.action === 'play' && r.spellCardId === 'BG36_884',
    );
    // Из руки карта уже оплачена: те же 24 стата без вычета цены.
    expect(play?.score).toBe(12);

    // Ход 17: та же карта во второй раз, игрок купил её в 00:49:08 — после
    // Портрета царицы за 3, продаж и подъёма. Советуется она и здесь;
    // в план на семи золотых после тринкета (с 17.09) она не входит:
    // Auto Assembler, сила и тёмный дар съедают остаток.
    const later = decisionPoint(17);
    const forgeLater = adviseTavern(later, { cards })?.recommendations.find(
      (r) => r.action === 'buy' && r.spellCardId === 'BG36_884',
    );
    expect(forgeLater?.score).toBe(12);
    expect(text).toContain('cardId=BG36_884');
  });

  /**
   * Монета силы Рафаама — `SW_COIN2` с текстом «Gain 1 Mana Crystal this
   * turn only»; игра показывает её «Золотой монеткой» (`OVERRIDECARDNAME`
   * меняет только имя). Розыгрыш в 00:39:35 снял `RESOURCES_USED` с 6 до 5.
   * Ход 7: игрок поднял таверну, сыграл монету, нажал силу и разыграл
   * Ancestral Automaton — план без монеты этой линии построить не мог
   * и писал «остаётся 1 — сгорит».
   */
  it('ход 7: монета Рафаама — золото, и план идёт линией игрока', () => {
    const state = decisionPoint(7);
    expect(state.handSpells.map((s) => s.cardId)).toContain('SW_COIN2');
    const plan = spendPlan(state, { cards });
    const actions = plan.steps.map((s) => `${s.recommendation.action}:${s.recommendation.spellCardId ?? ''}`);
    expect(actions).toContain('play:SW_COIN2');
    expect(actions).toContain('levelUp:');
    expect(plan.goldLeft).toBe(0);
  });

  /**
   * Ход 13, выбор тёмного дара (00:44:18). Дар кладётся на вариант ДО экрана:
   * Soulkeeping Jailer `BG36_503` родился 3/5 и в 00:44:17 стал 15/17.
   * Оценка по снапшоту ставила его ниже Glambot; по сущности — выше, и так же
   * говорит ближайший бой (+5.8 п.п., разбор part52). Игрок взял Glambot.
   */
  it('ход 13: вариант тёмного дара оценивается статами своей сущности', () => {
    const frame = at('00:44:19');
    const jailer = frame.openChoice?.options.find((o) => o.cardId === 'BG36_503');
    expect([jailer?.attack, jailer?.health, jailer?.techLevel]).toEqual([15, 17, 4]);
    const choice = adviseTavern(frame, { cards })?.choice ?? [];
    expect(choice[0]?.option.cardId).toBe('BG36_503');
    expect(choice[0]?.score).toBe(27);
  });

  /**
   * Ход 25: усиление всего борда ждёт в хвосте плана по D210, а строка
   * плана обрезана четырьмя шагами — главный шаг хода (Azerite Empowerment,
   * 154 очка) пропадал с экрана, хотя список советов звал его первым.
   */
  it('ход 25: скрытый шаг «усиление всего борда» называется по имени', () => {
    const state = decisionPoint(25);
    const plan = spendPlan(state, { cards });
    const azerite = plan.steps.find((s) => s.recommendation.spellCardId === 'BG28_169');
    expect(azerite?.recommendation.buffsWholeBoard).toBe(true);
    expect(plan.steps.indexOf(azerite!)).toBeGreaterThanOrEqual(4);
    expect(spendPlanLine(plan, cards)).toContain('Azerite Empowerment');
  });
});
