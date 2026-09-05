import { beforeAll, describe, expect, it } from 'vitest';

import type { PositionAdvice } from '../../src/advisors/position/advisor.js';
import type { PositionTarget, ResolvedOpponent } from '../../src/advisors/position/opponent.js';
import type {
  Recommendation,
  TavernAdvice,
  ValueBreakdown,
} from '../../src/advisors/tavern/advisor.js';
import type { SpendPlan, SpendStep } from '../../src/advisors/tavern/spend.js';
import { buildView, type ViewInput } from '../../src/overlay/view.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { EMPTY_STATE, type GameState } from '../../src/state/types.js';
import { recommendationLine } from '../../src/ui/format.js';
import { board, minion } from '../minions.js';

/**
 * Что оверлей показывает.
 *
 * Окно поверх игры тестом не проверить, поэтому всё, что можно решить заранее,
 * решено в `view.ts` — и проверяется здесь. На долю Electron остаётся создание
 * окна и передача этой структуры в разметку.
 */

const HERO: GameState['hero'] = {
  entityId: 64,
  cardId: 'BG20_HERO_282',
  health: 30,
  damage: 4,
  armor: 2,
  heroPowerCardId: null,
  heroPowerEntityId: null,
  heroPowerCost: null,
  heroPowerUsedThisTurn: false,
  heroPowerUnplayable: false,
  heroPowerLocked: false,
  heroPowerHasActivate: false,
  heroPowerScriptData: [],
};

const state: GameState = {
  ...EMPTY_STATE,
  phase: 'tavern',
  turn: 9,
  techLevel: 3,
  gold: 7,
  goldTotal: 7,
  hero: HERO,
  board: board([101, 102]),
  shop: board([201, 202]),
};

const tavern: TavernAdvice = {
  gold: 7,
  // На `turn: 9` кривая даёт РОВНО ТРИ: ход таверны здесь пятый, а тир 4
  // таблица обещает с седьмого. Пока поля не читал никто, четвёрка была
  // безвредна; блок темпа рисует её на экране, и фикстура утверждала бы
  // отставание на тир, которого нет.
  targetTier: 3,
  shopValues: [],
  trinkets: [],
  choice: [],
  playPlan: [],
  heroChoice: [],
  trinketForecast: null,
  recommendations: [
    {
      action: 'buy',
      minion: minion(201),
      score: 12,
      cost: 3,
      requiresSlot: true,
      sellFirst: minion(102),
      reason: 'своих по племени 2',
    },
    {
      action: 'levelUp',
      minion: null,
      score: 8,
      cost: 5,
      requiresSlot: false,
      sellFirst: null,
      reason: 'по графику пора',
    },
    {
      action: 'reroll',
      minion: null,
      score: 1,
      cost: 1,
      requiresSlot: false,
      sellFirst: null,
      reason: 'ничего не нравится',
    },
  ],
};

function opponent(patch: Partial<ResolvedOpponent> = {}): ResolvedOpponent {
  return {
    source: 'lastSeen',
    playerId: 5,
    board: board([301]),
    seenOnTurn: 7,
    staleTurns: 2,
    usable: true,
    ...patch,
  };
}

function single(patch: Partial<ResolvedOpponent> = {}): PositionTarget {
  return { kind: 'single', opponent: opponent(patch) };
}

/** Цель-поле с заданными давностями бордов. */
function field(staleTurns: readonly number[]): PositionTarget {
  return {
    kind: 'field',
    boards: staleTurns.map((stale, i) => ({
      playerId: i + 2,
      board: board([301 + i]),
      seenOnTurn: 9 - stale,
      staleTurns: stale,
    })),
  };
}

function advice(patch: Partial<PositionAdvice> = {}): PositionAdvice {
  return {
    top: [{ key: 'a', board: board([102, 101]), estimate: estimate(), score: 0.6 }],
    current: { key: 'b', board: board([101, 102]), estimate: estimate(), score: 0.5 },
    improves: true,
    gain: 6.2,
    winGain: 5.1,
    rallyNote: null,
    elapsedMs: 3200,
    report: {
      top: [],
      current: { key: 'b', board: board([101, 102]), estimate: estimate(), score: 0.5 },
      evaluated: 120,
      simulations: 40_000,
      elapsedMs: 3200,
      space: { size: 2, total: 2, distinct: 2 },
    },
    ...patch,
  } as PositionAdvice;
}

function estimate(): PositionAdvice['current']['estimate'] {
  return {
    sims: 1000,
    won: 540,
    tied: 60,
    lost: 400,
    wonLethal: 0,
    lostLethal: 0,
    damageWon: 0,
    damageLost: 0,
  };
}

const input = (patch: Partial<ViewInput> = {}): ViewInput => ({
  state,
  tavern,
  thinking: false,
  position: null,
  ...patch,
});

/** Шаг плана: совет плюс золото до и после него. */
function step(recommendation: Recommendation, goldBefore: number, goldAfter: number): SpendStep {
  return {
    recommendation,
    goldBefore,
    goldAfter,
    opaque: false,
    stateAfter: { ...state, gold: goldAfter },
  };
}

/** План из двух шагов, тратящий всё золото; варианты — заплаткой. */
function plan(patch: Partial<SpendPlan> = {}): SpendPlan {
  return {
    steps: [step(tavern.recommendations[0]!, 7, 4), step(tavern.recommendations[1]!, 4, 0)],
    goldLeft: 0,
    truncated: false,
    ...patch,
  };
}

describe('вид оверлея', () => {
  let cards: CardIndex;

  beforeAll(() => {
    cards = loadCardIndex();
  }, 60_000);

  it('до выбора героя показывать нечего', () => {
    const view = buildView(input({ state: { ...state, hero: null } }), cards);
    expect(view.active).toBe(false);
  });

  it('шапка, борд, витрина и три первых совета', () => {
    const view = buildView(input(), cards);

    expect(view.header).toContain('ход 9');
    expect(view.header).toContain('золото 7/7');
    // Здоровье с бронёй: 30 − 4 урона, плюс 2 брони.
    expect(view.header).toContain('hp 26+2');
    expect(view.board).toHaveLength(2);
    expect(view.shop).toHaveLength(2);

    // Три совета, не больше: с «разыграть» и подъёмом-приоритетом в топе
    // обычно сочетание разных действий, а простыня оверлею всё же не к лицу.
    expect(view.actions).toHaveLength(3);
    expect(view.actions[0]?.tone).toBe('good');
  });

  it('план трат — своим блоком; в списке советов место одно, как и было', () => {
    // Ход состоит из нескольких действий, и описывать его целиком по-прежнему
    // обязано то, что стоит выше советов. Изменилась ФОРМА этого решения,
    // а не оно само: вместо одной плотной строки — блок по шагу в строку,
    // где виден остаток золота после каждого шага. Место в списке план
    // занимает прежнее — ровно одно: первый шаг почти всегда и есть верхний
    // совет, и третья строка была бы платой за повтор.
    const view = buildView(input({ spendPlan: plan() }), cards);

    expect(view.plan?.gold).toBe(7);
    expect(view.plan?.steps).toHaveLength(2);
    expect(view.plan?.steps[0]?.no).toBe(1);
    // Текст шага — тот же форматтер, что у совета: второе определение того,
    // как назвать жертву и цель, разъехалось бы с первым молча.
    expect(view.plan?.steps[0]?.text).toBe(
      recommendationLine(tavern.recommendations[0]!, cards),
    );
    expect(view.plan?.steps[0]?.goldAfter).toBe(4);
    // Потрачено всё — говорить не о чем.
    expect(view.plan?.tail).toBeNull();
    expect(view.plan?.restVerbs).toHaveLength(0);
    expect(view.plan?.goldCaption).toBe('остаток');

    expect(view.actions).toHaveLength(2);
    expect(view.actions[0]?.text).toContain('КУПИТЬ');
    // Зелёный акцент отдан блоку: два зелёных объекта на экране спорили бы
    // за то, с чего начинать читать.
    expect(view.actions[0]?.tone).toBe('normal');

    // План из одного шага блоком не рисуется — это и есть верхняя строка.
    const one = buildView(
      input({ spendPlan: plan({ steps: [plan().steps[0]!] }) }),
      cards,
    );
    expect(one.plan).toBeNull();
    expect(one.actions[0]?.tone).toBe('good');
  });

  it('сгорающий остаток назван словами и помечен на последнем шаге', () => {
    const burning = plan({
      steps: [step(tavern.recommendations[0]!, 7, 4), step(tavern.recommendations[1]!, 4, 2)],
      goldLeft: 2,
    });
    const view = buildView(input({ spendPlan: burning }), cards);

    expect(view.plan?.tail?.text).toContain('остаётся 2 — сгорит');
    expect(view.plan?.tail?.tone).toBe('warn');
    expect(view.plan?.steps[1]?.goldTone).toBe('warn');
    // Помечен только последний: остальные остатки по дороге не сгорают.
    expect(view.plan?.steps[0]?.goldTone).toBe('muted');
  });

  it('оборванный план называет и обрыв, и остаток, но не обещает сгорания', () => {
    // Витрина после обновления будет другая, и остаток потратит уже она —
    // утверждать сгорание нельзя. Молчать о нём тоже нельзя: он посчитан.
    const cut = plan({ goldLeft: 3, truncated: true });
    const view = buildView(input({ spendPlan: cut }), cards);

    expect(view.plan?.tail?.text).toContain('дальше по новой витрине');
    expect(view.plan?.tail?.text).toContain('остаётся 3');
    expect(view.plan?.tail?.text).not.toContain('сгорит');
    expect(view.plan?.tail?.tone).toBe('muted');
    expect(view.plan?.steps[1]?.goldTone).toBe('muted');
  });

  it('шаги сверх предела блока не пропадают: остаются глаголами', () => {
    const many = plan({
      steps: [
        step(tavern.recommendations[0]!, 12, 9),
        step(tavern.recommendations[0]!, 9, 6),
        step(tavern.recommendations[0]!, 6, 5),
        step(tavern.recommendations[0]!, 5, 4),
        step(tavern.recommendations[0]!, 4, 3),
        step(tavern.recommendations[1]!, 3, 2),
        step(tavern.recommendations[2]!, 2, 0),
      ],
    });
    const view = buildView(input({ spendPlan: many }), cards);

    expect(view.plan?.steps).toHaveLength(5);
    expect(view.plan?.restVerbs).toEqual(['ПОДНЯТЬ ТАВЕРНУ', 'ОБНОВИТЬ']);
  });

  it('остаток при силе героя, дающей золото броском, подписан нижней гранью', () => {
    // В план такая сила кладёт худший бросок (part39), а очки считает
    // по среднему: столбик после неё — минимум, и подпись обязана это сказать,
    // иначе игрок сверит с игрой и решит, что советник врёт.
    const die: Recommendation = {
      action: 'heroPower',
      minion: null,
      score: 7.5,
      cost: 1,
      requiresSlot: false,
      sellFirst: null,
      grantsGold: 1,
      reason: 'бросок кубика на 6 граней',
    };
    const view = buildView(
      input({ spendPlan: plan({ steps: [step(die, 5, 5), step(tavern.recommendations[0]!, 5, 2)] }) }),
      cards,
    );
    expect(view.plan?.goldCaption).toBe('остаток не меньше');
  });

  it('темп: шкала кривой, ваша клетка и клетка кривой', () => {
    const view = buildView(input(), cards);

    // Шкала длиной с саму кривую, а не по нынешний тир: тег предела тира
    // не встречается ни в одной фикстуре, и шкала, кончающаяся на клетке
    // игрока, читалась бы как «вы на вершине».
    expect(view.tempo?.cells).toHaveLength(6);
    expect(view.tempo?.cells.filter((c) => c.you).map((c) => c.tier)).toEqual([3]);
    expect(view.tempo?.cells.filter((c) => c.curve).map((c) => c.tier)).toEqual([3]);
    expect(view.tempo?.cells.some((c) => c.locked)).toBe(false);

    // Ход называется в той шкале, в которой считает кривая: наш `turn` 9 —
    // это пятый ход ТАВЕРНЫ (урок part20).
    expect(view.tempo?.tavernTurn).toBe(5);
    expect(view.tempo?.tier).toBe(3);
    expect(view.tempo?.curveTier).toBe(3);
  });

  it('темп: слова — дословная причина совета подъёма, своих формулировок нет', () => {
    // Причин у правила четыре, а на четверти точек совета подъёма нет вовсе.
    // Своя склейка на них была бы выдумкой, а расхождение подписи с советом
    // в списке читалось бы как второй, скрытый вердикт.
    const view = buildView(input(), cards);
    expect(view.tempo?.note).toBe('по графику пора');
    // Цена уже названа причиной — вторым числом её не повторяем.
    expect(view.tempo?.upgrade).toBeNull();
  });

  it('темп: совета подъёма нет — слов нет, а цена берётся из лога', () => {
    const noLevel: TavernAdvice = {
      ...tavern,
      recommendations: tavern.recommendations.filter((r) => r.action !== 'levelUp'),
    };
    const withCost: GameState = { ...state, tavernUpgradeCost: 5, tavernUpgradeTarget: 4 };
    const view = buildView(input({ tavern: noLevel, state: withCost }), cards);

    expect(view.tempo?.note).toBeNull();
    expect(view.tempo?.upgrade).toEqual({ cost: 5, target: 4 });

    // Кнопки не видно — ни нуля, ни «бесплатно» вместо неё не подставляется.
    const blind = buildView(input({ tavern: noLevel }), cards);
    expect(blind.tempo?.upgrade).toBeNull();
  });

  it('темп: известный предел тира гасит клетки выше себя', () => {
    // Тега предела в фикстурах нет ни разу, но если он придёт — клетки выше
    // должны гаснуть, а не исчезать: кривая просит тир, которого не будет.
    const capped: GameState = { ...state, maxTechLevel: 5 };
    const view = buildView(input({ state: capped }), cards);

    expect(view.tempo?.cells).toHaveLength(6);
    expect(view.tempo?.cells.filter((c) => c.locked).map((c) => c.tier)).toEqual([6]);
  });

  it('модальный выбор гасит и план, и темп', () => {
    // Пока открыт выбор, игрок решает именно его; план вдобавок посчитан
    // на состоянии, которого сейчас на экране нет.
    const withTrinkets: TavernAdvice = {
      ...tavern,
      trinkets: [
        {
          offer: { entityId: 7, cardId: 'T1', subsetRaces: ['MECH'], cost: 2 },
          name: 'Компас',
          tribeMinions: 2,
          averagePlacement: 4.1,
          reason: 'упоминает MECH — своих 2',
        },
      ],
    };
    const trinkets = buildView(input({ tavern: withTrinkets, spendPlan: plan() }), cards);
    expect(trinkets.plan).toBeNull();
    expect(trinkets.tempo).toBeNull();

    const withChoice: TavernAdvice = {
      ...tavern,
      choice: [
        {
          option: { entityId: 1, cardId: 'A' },
          name: 'Часовой',
          value: null,
          score: null,
          reason: 'оценить не берёмся',
        },
      ],
    };
    const choice = buildView(input({ tavern: withChoice, spendPlan: plan() }), cards);
    expect(choice.plan).toBeNull();
    expect(choice.tempo).toBeNull();
  });

  it('вне таверны и на выборе героя блоков нет', () => {
    const combat = buildView(input({ tavern: null, spendPlan: plan() }), cards);
    expect(combat.plan).toBeNull();
    expect(combat.tempo).toBeNull();

    const withHero: TavernAdvice = {
      ...tavern,
      heroChoice: [
        {
          option: { entityId: 1, cardId: 'BG20_HERO_282' },
          name: 'Джандис',
          averagePosition: 3.9,
          reason: 'среднее место 3.90 по статистике',
        },
      ],
    };
    const hero = buildView(input({ tavern: withHero, spendPlan: plan() }), cards);
    expect(hero.plan).toBeNull();
    expect(hero.tempo).toBeNull();
  });

  it('метки: шаги плана садятся на карты витрины и кнопки таверны', () => {
    const view = buildView(input({ spendPlan: plan() }), cards);

    const buy = view.marks.find((m) => m.row === 'shop');
    expect(buy?.index).toBe(0);
    expect(buy?.count).toBe(2);
    expect(buy?.tone).toBe('buy');
    expect(buy?.step).toBe(1);
    expect(buy?.label).toContain('КУПИТЬ');

    // Подъём — не карта: у него своя кнопка, и метка идёт на неё.
    const level = view.marks.find((m) => m.button === 'levelUp');
    expect(level?.step).toBe(2);
    expect(level?.label).toContain('ПОДНЯТЬ');

    // Жертва названа словами в строке действия, а на столе ей нужно кольцо.
    const sell = view.marks.find((m) => m.tone === 'sell');
    expect(sell?.row).toBe('board');
    expect(sell?.index).toBe(1);
    expect(sell?.step).toBeNull();
  });

  it('метки: заклинание витрины стоит в ОДНОМ ряду с миньонами', () => {
    // part41, ход 5: миньоны на местах 1, 2 и 4, а «Recruit a Trainee»
    // ТРЕТЬИМ. Пока ряд считался по одним миньонам, советник видел ряд
    // из трёх карт вместо четырёх, кольцо уезжало на полшага, а у самого
    // заклинания метки не было вовсе — оба пункта игрока.
    const shop = [minion(201, { zonePos: 1 }), minion(202, { zonePos: 2 }), minion(203, { zonePos: 4 })];
    const buySpell: Recommendation = {
      action: 'buy',
      minion: null,
      spellCardId: 'BG28_504',
      score: 6.4,
      cost: 2,
      requiresSlot: false,
      sellFirst: null,
      reason: 'даёт миньона',
    };
    const view = buildView(
      input({
        state: {
          ...state,
          shop,
          shopSpells: [
            {
              entityId: 775,
              cardId: 'BG28_504',
              zonePos: 3,
              cost: 2,
              scriptData: [],
              unplayable: false,
              costsHealth: false,
            },
          ],
        },
        tavern: { ...tavern, recommendations: [buySpell] },
      }),
      cards,
    );

    const mark = view.marks.find((m) => m.row === 'shop');
    expect(mark?.count, 'ряд из четырёх карт, а не из трёх миньонов').toBe(4);
    expect(mark?.index, 'заклинание стоит третьим').toBe(2);
    expect(mark?.label).toContain('КУПИТЬ');

    // И место миньона в том же ряду считается по позиции, а не по номеру
    // в списке: четвёртая карта ряда — это индекс 3, хотя миньон третий.
    const buyLast: Recommendation = { ...buySpell, minion: minion(203, { zonePos: 4 }), spellCardId: null };
    const last = buildView(
      input({
        state: {
          ...state,
          shop,
          shopSpells: [
            {
              entityId: 775,
              cardId: 'BG28_504',
              zonePos: 3,
              cost: 2,
              scriptData: [],
              unplayable: false,
              costsHealth: false,
            },
          ],
        },
        tavern: { ...tavern, recommendations: [buyLast] },
      }),
      cards,
    );
    expect(last.marks.find((m) => m.row === 'shop')?.index).toBe(3);
  });

  it('метки: заморозка РАДИ заклинания помечает и кнопку, и саму карту', () => {
    // У такого совета `minion` пуст (витрину держат ради заклинания,
    // ветка part17 → part29), и кольца на карте не было вовсе — совет
    // читался как «заморозить просто так».
    const freezeForSpell: Recommendation = {
      action: 'freeze',
      minion: null,
      spellCardId: 'BG28_512',
      score: 8.5,
      cost: 0,
      requiresSlot: false,
      sellFirst: null,
      reason: 'даёт миньона, а золота не хватает',
    };
    const view = buildView(
      input({
        state: {
          ...state,
          shop: [minion(201, { zonePos: 1 })],
          shopSpells: [
            {
              entityId: 900,
              cardId: 'BG28_512',
              zonePos: 2,
              cost: 2,
              scriptData: [],
              unplayable: false,
              costsHealth: false,
            },
          ],
        },
        tavern: { ...tavern, recommendations: [freezeForSpell] },
      }),
      cards,
    );

    expect(view.marks.find((m) => m.button === 'freeze')?.tone).toBe('tavern');
    const card = view.marks.find((m) => m.row === 'shop');
    expect(card?.index).toBe(1);
    expect(card?.count).toBe(2);
    expect(card?.tone).toBe('keep');
  });

  it('метки: у кнопок таверны свой цвет, а не цвет покупки', () => {
    // Кнопка подъёма сама зелёно-золотая, и зелёное кольцо на ней теряется
    // (жалоба игрока по part41). Смысл действия у кнопки назван словом,
    // у карт же цвет — единственное различие покупки и продажи.
    const view = buildView(input({ spendPlan: plan() }), cards);
    expect(view.marks.find((m) => m.button === 'levelUp')?.tone).toBe('tavern');
    expect(view.marks.find((m) => m.row === 'shop')?.tone).toBe('buy');
  });

  it('метки: карту руки разместить негде, и она метки не получает', () => {
    // Рука лежит веером, её геометрия не замерена. Кольцо наугад показало бы
    // на чужую карту — это хуже, чем отсутствие кольца.
    const inHand: Recommendation = {
      action: 'play',
      minion: minion(999),
      score: 9,
      cost: 0,
      requiresSlot: true,
      sellFirst: null,
      reason: 'разыграть из руки',
    };
    const view = buildView(
      input({ spendPlan: plan({ steps: [step(inHand, 7, 7), step(tavern.recommendations[1]!, 7, 2)] }) }),
      cards,
    );
    expect(view.marks.some((m) => m.row !== null)).toBe(false);
    // Кнопка подъёма при этом помечена: шаг, который разместить МОЖНО,
    // от соседства с неразмещаемым не страдает.
    expect(view.marks.some((m) => m.button === 'levelUp')).toBe(true);
  });

  it('метки: одна карта помечается один раз', () => {
    // Два кольца на одной карте спорят, какое из них главное, — тот же довод,
    // по которому план занимает в списке одно место.
    const twice = plan({
      steps: [step(tavern.recommendations[0]!, 7, 4), step(tavern.recommendations[0]!, 4, 1)],
    });
    const view = buildView(input({ spendPlan: twice }), cards);
    const shopMarks = view.marks.filter((m) => m.row === 'shop' && m.index === 0);
    expect(shopMarks).toHaveLength(1);
    expect(shopMarks[0]?.step).toBe(1);
  });

  it('метки: без плана помечается верхний совет и БЕЗ номера шага', () => {
    // Номер шага у одного действия обещал бы цепочку, которой нет.
    const view = buildView(input(), cards);
    const buy = view.marks.find((m) => m.row === 'shop');
    expect(buy?.index).toBe(0);
    expect(buy?.step).toBeNull();
  });

  it('метки: у действия с целью оба кольца подписаны', () => {
    // Активация с целью — худший случай: нажимают ОДНУ карту, а меняется
    // другая. Голубое кольцо без слова читалось бы как «тут тоже что-то
    // делать», и игрок нажал бы не то.
    const activate: Recommendation = {
      action: 'activate',
      minion: minion(101),
      targetMinion: minion(102),
      score: 42.5,
      cost: 1,
      requiresSlot: false,
      sellFirst: null,
      reason: 'сделает соседа 50/50',
    };
    const view = buildView(
      input({ tavern: { ...tavern, recommendations: [activate] } }),
      cards,
    );

    const actor = view.marks.find((m) => m.index === 0 && m.row === 'board');
    expect(actor?.label).toContain('АКТИВИРОВАТЬ');
    expect(actor?.tone).toBe('buy');

    const target = view.marks.find((m) => m.tone === 'target');
    expect(target?.row).toBe('board');
    expect(target?.index).toBe(1);
    expect(target?.label).toBe('ЦЕЛЬ');
  });

  it('метки: носитель магнита подписан своим словом, а не «цель»', () => {
    // Магнит не «целится» — он садится НА носителя, и это разные действия:
    // цель усиления получает статы, носитель магнита получает саму карту.
    const magnet: Recommendation = {
      action: 'buy',
      minion: minion(201),
      magnetizeTo: minion(101),
      score: 12,
      cost: 3,
      requiresSlot: false,
      sellFirst: null,
      reason: 'магнитный мех',
    };
    const view = buildView(input({ tavern: { ...tavern, recommendations: [magnet] } }), cards);
    const carrier = view.marks.find((m) => m.tone === 'target');
    expect(carrier?.label).toBe('НОСИТЕЛЬ');
  });

  it('метки: модальный экран гасит и кольца, и номера расстановки', () => {
    const withChoice: TavernAdvice = {
      ...tavern,
      choice: [
        {
          option: { entityId: 1, cardId: 'A' },
          name: 'Часовой',
          value: null,
          score: null,
          reason: 'оценить не берёмся',
        },
      ],
    };
    const view = buildView(
      input({
        tavern: withChoice,
        spendPlan: plan(),
        position: { kind: 'advice', advice: advice(), target: single() },
      }),
      cards,
    );
    expect(view.marks).toHaveLength(0);
    expect(view.order).toHaveLength(0);
  });

  it('метки: лавка аксессуаров помечает советуемый вариант, порядок — из канала выборов', () => {
    // Просьба игрока по part41: «хочу, чтобы также подсказывало на ui
    // с тринкетами, как и с картами». Порядок на экране знает ТОЛЬКО канал
    // выборов: у сущностей тринкетов в SETASIDE позиция не проставлена —
    // все четыре с `zonePos=0`, — а порядок `trinketOffer` экрану не равен.
    // Числа взяты с кадра: советуемая «Чешуя волшебного дракона» стоит
    // на экране ЧЕТВЁРТОЙ, а в `trinketOffer` — второй.
    const offer = (entityId: number, cardId: string, cost: number | null) => ({
      entityId,
      cardId,
      subsetRaces: [],
      cost,
    });
    const scale = offer(6616, 'BG32_MagicItem_363', 3);
    const withTrinkets: TavernAdvice = {
      ...tavern,
      trinkets: [
        { offer: scale, name: 'Faerie Dragon Scale', tribeMinions: 5, reason: 'упоминает DRAGON' },
        {
          offer: offer(6618, 'BG32_MagicItem_366', 1),
          name: 'Guiding Candle',
          tribeMinions: 0,
          reason: 'эффект вне племён',
        },
      ],
    };
    const openChoice: GameState['openChoice'] = {
      id: 8,
      sourceCardId: 'BG30_Trinket_2nd',
      options: [
        { entityId: 6618, cardId: 'BG32_MagicItem_366' },
        { entityId: 6617, cardId: 'BG36_MagicItem_309' },
        { entityId: 6615, cardId: 'BG30_MagicItem_993' },
        { entityId: 6616, cardId: 'BG32_MagicItem_363' },
      ],
    };

    const view = buildView(
      input({ state: { ...state, openChoice }, tavern: withTrinkets, spendPlan: plan() }),
      cards,
    );

    expect(view.marks).toHaveLength(1);
    const mark = view.marks[0]!;
    expect(mark.row).toBe('trinket');
    expect(mark.index, 'на экране он четвёртый').toBe(3);
    expect(mark.count).toBe(4);
    // Цена в метке обязательна: в одном предложении варианты стоят разного.
    expect(mark.label).toBe('ВЗЯТЬ · 3');
    // Стол за модальным экраном по-прежнему не помечается, и номеров нет.
    expect(view.marks.some((m) => m.row === 'shop' || m.row === 'board')).toBe(false);
    expect(view.order).toHaveLength(0);
  });

  it('метки: без открытого выбора лавка молчит, а панель — нет', () => {
    // Зонный путь тринкетов опаздывает (part9: в точке решения 3 варианта
    // из 4). Кольцо наугад показало бы на чужую карту, а список советов
    // остаётся на месте и всё называет словами.
    const withTrinkets: TavernAdvice = {
      ...tavern,
      trinkets: [
        {
          offer: { entityId: 6616, cardId: 'BG32_MagicItem_363', subsetRaces: [], cost: 3 },
          name: 'Faerie Dragon Scale',
          tribeMinions: 5,
          reason: 'упоминает DRAGON',
        },
      ],
    };
    const view = buildView(input({ tavern: withTrinkets }), cards);
    expect(view.marks).toHaveLength(0);
    expect(view.actions[0]?.text).toContain('Faerie Dragon Scale');
  });

  it('метки: лавка без основания для порядка кольца не получает', () => {
    // Когда ни племён, ни статистики, порядок вариантов задан обходом
    // сущностей — кольцо на первом утверждало бы выбор, которого мы
    // не делали. Панель при этом всё равно показывает все варианты.
    const withUnknown: TavernAdvice = {
      ...tavern,
      trinkets: [
        {
          offer: { entityId: 1, cardId: 'X', subsetRaces: [], cost: 2 },
          name: 'Неизвестный',
          tribeMinions: 0,
          averagePlacement: null,
          reason: 'оценить не берёмся',
        },
      ],
    };
    const view = buildView(
      input({
        state: {
          ...state,
          openChoice: { id: 1, sourceCardId: 'BG30_Trinket_1st', options: [{ entityId: 1, cardId: 'X' }] },
        },
        tavern: withUnknown,
      }),
      cards,
    );
    expect(view.marks).toHaveLength(0);
    expect(view.actions[0]?.text).toContain('Неизвестный');
  });

  it('номера расстановки появляются только когда совет что-то меняет', () => {
    // Расстановка молчит большую часть партии; номера, повторяющие нынешний
    // порядок, были бы шумом на каждом кадре.
    const improving = buildView(
      input({ position: { kind: 'advice', advice: advice(), target: single() } }),
      cards,
    );
    // Фикстура советует обратный порядок: 101 уходит вторым, 102 первым.
    expect(improving.order).toHaveLength(2);
    expect(improving.order.map((o) => [o.index, o.order, o.moved])).toEqual([
      [0, 2, true],
      [1, 1, true],
    ]);
    // Прямоугольники разные и стоят слева направо по нынешнему месту.
    expect(improving.order[0]!.rect.x).toBeLessThan(improving.order[1]!.rect.x);

    const same = buildView(
      input({
        position: { kind: 'advice', advice: advice({ improves: false }), target: single() },
      }),
      cards,
    );
    expect(same.order).toHaveLength(0);
  });

  it('покупка на полном борде называет, кого продать', () => {
    const view = buildView(input(), cards);
    expect(view.actions[0]?.text).toContain('продав');
  });

  it('досчёт покупок: несогласие боя выделено, шум приглушён', () => {
    const target = single();
    const outcome = (cardId: string, outcome: number) => ({
      cardId,
      entityId: 1,
      sims: 800,
      outcome,
    });

    // Бой предпочёл другую покупку — ради этого досчёт и существует.
    const disagree = buildView(
      input({
        buyCheck: {
          target,
          result: {
            outcomes: [outcome('BG_B', 62), outcome('BG_A', 48)],
            spread: 14,
            noise: 5,
            decisive: true,
            agreed: false,
            elapsedMs: 400,
          },
        },
      }),
      cards,
    );
    const line = disagree.actions[disagree.actions.length - 1];
    expect(line?.text).toContain('ПО БОЮ ЛУЧШЕ');
    expect(line?.tone).toBe('warn');

    // Разброс в шуме: «лучший» случаен, строка приглушена.
    const noisy = buildView(
      input({
        buyCheck: {
          target,
          result: {
            outcomes: [outcome('BG_B', 51), outcome('BG_A', 50)],
            spread: 1,
            noise: 5,
            decisive: false,
            agreed: true,
            elapsedMs: 400,
          },
        },
      }),
      cards,
    );
    const noisyLine = noisy.actions[noisy.actions.length - 1];
    expect(noisyLine?.text).toContain('неразличимы');
    expect(noisyLine?.tone).toBe('muted');

    // Насыщенный исход — не «кандидаты равны», а «цель уже не соперник».
    const saturated = buildView(
      input({
        buyCheck: {
          target,
          result: {
            outcomes: [outcome('BG_B', 100), outcome('BG_A', 100)],
            spread: 0,
            noise: 5,
            decisive: false,
            agreed: true,
            elapsedMs: 400,
          },
        },
      }),
      cards,
    );
    const saturatedLine = saturated.actions[saturated.actions.length - 1];
    expect(saturatedLine?.text).toContain('выигрывается любой покупкой');
  });

  it('предупреждение продукта — первой строкой, поверх лимита советов', () => {
    // «Снапшот отстал от патча» обесценивает советы ниже — прятать нельзя.
    const view = buildView(input({ warning: 'снапшот карт отстал от патча' }), cards);
    expect(view.actions[0]?.text).toContain('отстал от патча');
    expect(view.actions[0]?.tone).toBe('warn');
    // Советы не вытеснены: все три строки на месте, ниже предупреждения.
    expect(view.actions.length).toBe(4);
  });

  it('напоминание о тринкетах — приглушённой строкой поверх лимита советов', () => {
    // Напоминание — подготовка борда к следующему ходу (тьюторинг,
    // docs/jeefhs.md); спрятанное за тремя покупками оно не видно никогда.
    const withForecast = { ...tavern, trinketForecast: 'следующим ходом — выбор тринкета' };
    const view = buildView(input({ tavern: withForecast }), cards);

    const last = view.actions[view.actions.length - 1];
    expect(last?.text).toContain('выбор тринкета');
    expect(last?.tone).toBe('muted');
    // Советы напоминание не вытесняет: все три строки на месте.
    expect(view.actions).toHaveLength(4);
  });

  it('открытый выбор карт вытесняет советы, лучший помечен', () => {
    const breakdown = (total: number): ValueBreakdown => ({
      techLevel: 0,
      stats: 0,
      tribe: 0,
      keywords: 0,
      copies: 0,
      golden: 0,
      economy: 0,
      battle: 0,
      doubler: 0,
      heroPower: 0,
      textTribe: 0,
      textMech: 0,
      namedCard: 0,
      spellMagnet: 0,
      total,
      tribeMates: 0,
      textTribeMates: 0,
      textMechMates: 0,
      namedCardMates: 0,
      copiesOwned: 0,
      completesTriple: false,
      tripleBet: false,
      heroPowerPlay: 0,
      heroPowerBuy: 0,
      heroPowerBuyLeft: null,
      heroPowerBuyReward: null,
    });
    const withChoice: TavernAdvice = {
      ...tavern,
      choice: [
        {
          option: { entityId: 1, cardId: 'A' },
          name: 'Часовой',
          value: breakdown(18),
          score: 18,
          reason: 'тир 4, ценность 18.0',
        },
        {
          option: { entityId: 2, cardId: 'B' },
          name: 'Дар',
          value: null,
          score: null,
          reason: 'оценить не берёмся',
        },
      ],
    };
    const view = buildView(input({ tavern: withChoice }), cards);

    expect(view.actions[0]?.text).toContain('ВЫБРАТЬ?');
    expect(view.actions[0]?.text).toContain('Часовой');
    expect(view.actions[0]?.tone).toBe('good');
    expect(view.actions).toHaveLength(2);
  });

  it('выбор из одних неоценённых вариантов всё равно показывается', () => {
    // part10, ход 17: три сокровища-заклинания, а оверлей советовал покупки,
    // будто модального экрана нет. Открытый выбор доминирует всегда.
    const withSpells: TavernAdvice = {
      ...tavern,
      choice: [
        {
          option: { entityId: 1, cardId: 'A' },
          name: 'Дар',
          value: null,
          score: null,
          reason: 'оценить не берёмся',
        },
      ],
    };
    const view = buildView(input({ tavern: withSpells }), cards);
    expect(view.actions[0]?.text).toContain('ВЫБРАТЬ?');
    expect(view.actions[0]?.tone).toBe('normal');
  });

  it('план на несколько розыгрышей заменяет отдельные строки «разыграть»', () => {
    const playRec = (id: number, score: number): Recommendation => ({
      action: 'play',
      minion: minion(id),
      score,
      cost: 0,
      requiresSlot: false,
      sellFirst: null,
      reason: 'из руки',
    });
    const withPlan: TavernAdvice = {
      ...tavern,
      recommendations: [playRec(11, 20), playRec(12, 15), ...tavern.recommendations.slice(1)],
      playPlan: [
        { minion: minion(11), magnetizeTo: null, sellFirst: null, score: 20 },
        { minion: minion(12), magnetizeTo: minion(101), sellFirst: null, score: 15 },
      ],
    };
    const view = buildView(input({ tavern: withPlan }), cards);

    expect(view.actions[0]?.text).toContain('ПО ПОРЯДКУ');
    expect(view.actions[0]?.text).toContain('примагнитить к');
    // Отдельные «разыграть» свёрнуты в одну строку плана.
    expect(view.actions.filter((a) => a.text.includes('РАЗЫГРАТЬ'))).toHaveLength(1);
  });

  it('идущий счёт показывается вместо прошлого совета', () => {
    const view = buildView(
      input({ thinking: true, position: { kind: 'advice', advice: advice(), target: single() } }),
      cards,
    );

    // Показать старый совет как действующий — это ровно тот случай, когда
    // игрок делает ход по числам, которых уже нет.
    expect(view.position?.text).toBe('считаю расстановку…');
    expect(view.position?.tone).toBe('muted');
  });

  it('брошенный счёт виден, а не молчит', () => {
    const view = buildView(input({ position: { kind: 'dropped' } }), cards);
    expect(view.position?.text).toContain('брошен');
  });

  it('отсутствие картинки противника объясняется', () => {
    const view = buildView(
      input({ position: { kind: 'noOpponent', opponent: opponent({ source: 'unseen', usable: false }) } }),
      cards,
    );
    expect(view.position?.text).toContain('ещё не видели');
  });

  it('свежий совет показывается как совет', () => {
    const view = buildView(
      input({ position: { kind: 'advice', advice: advice(), target: single() } }),
      cards,
    );

    expect(view.position?.tone).toBe('good');
    expect(view.position?.text).toContain('+6.2 п.п.');
    expect(view.position?.text).not.toContain('устарела');
  });

  it('совет по устаревшей картинке помечается', () => {
    const view = buildView(
      input({
        position: { kind: 'advice', advice: advice(), target: single({ staleTurns: 13 }) },
      }),
      cards,
    );

    // Числа против борда 13-ходовой давности вырождаются: в фикстурах там
    // выходит 100% побед против того, чего давно нет.
    expect(view.position?.tone).toBe('warn');
    expect(view.position?.text).toContain('устарела');
  });

  it('совет против поля называет, из скольких бордов оно собрано', () => {
    const view = buildView(
      input({ position: { kind: 'advice', advice: advice(), target: field([1, 3, 5]) } }),
      cards,
    );

    // Игрок обязан видеть, что это средний исход по полю, а не бой
    // с конкретным противником: смысл чисел другой.
    expect(view.position?.tone).toBe('good');
    expect(view.position?.text).toContain('по полю из 3 бордов');
    expect(view.position?.text).toContain('1–5 ходов');

    // Поле из одного борда — не «из 1 бордов»: подпись читает человек.
    const one = buildView(
      input({ position: { kind: 'advice', advice: advice(), target: field([2]) } }),
      cards,
    );
    expect(one.position?.text).toContain('из 1 борда');
    expect(one.position?.text).toContain('давность 2 хода');
  });

  it('поле из одних устаревших бордов помечается, из свежих и старых — нет', () => {
    const allStale = buildView(
      input({ position: { kind: 'advice', advice: advice(), target: field([6, 9, 13]) } }),
      cards,
    );
    expect(allStale.position?.tone).toBe('warn');
    expect(allStale.position?.text).toContain('устарела');

    // Пока хоть одна картинка свежа, средний исход опирается не только
    // на прошлое — пугать игрока не за что.
    const mixed = buildView(
      input({ position: { kind: 'advice', advice: advice(), target: field([1, 9, 13]) } }),
      cards,
    );
    expect(mixed.position?.tone).toBe('good');
  });
});

/**
 * Блок прогноза места — единственная строка вида, которая не советует.
 * Число приходит полем снаружи (`PlaceForecaster`), а вид отвечает
 * за подачу: рядом с числом обязаны стоять его ошибка и выборка, иначе
 * прогноз читается как знание (docs/ml.md, «Перезамер 05.09.2026»).
 */
describe('прогноз места', () => {
  let cards: CardIndex;

  beforeAll(() => {
    cards = loadCardIndex();
  }, 60_000);

  it('показывается с ошибкой, выборкой и подписью «не совет»', () => {
    const view = buildView(
      input({ forecast: { place: 3.42, error: 1.689, games: 43 } }),
      cards,
    );

    expect(view.forecast?.place).toBeCloseTo(3.42, 2);
    expect(view.forecast?.error).toBeCloseTo(1.689, 3);
    expect(view.forecast?.games).toBe(43);
    expect(view.forecast?.label).toContain('не совет');
  });

  it('без прогноза блока нет вовсе', () => {
    expect(buildView(input(), cards).forecast).toBeNull();
    expect(buildView(input({ forecast: null }), cards).forecast).toBeNull();
  });

  /**
   * Модальный экран гасит план и темп — они про золото и витрину, которых
   * за модалкой нет. Прогноз остаётся: он про партию целиком, и выбор
   * тринкета его не устаревает.
   */
  it('переживает модальный экран, в отличие от плана и темпа', () => {
    const withTrinkets: TavernAdvice = {
      ...tavern,
      trinkets: [
        {
          offer: { entityId: 77, cardId: 'BG30_MagicItem_701', subsetRaces: [], cost: 3 },
          name: 'Хрустальный шар',
          tribeMinions: 0,
          averagePlacement: null,
          reason: 'своих таких нет',
        },
      ],
    };

    const view = buildView(
      input({ tavern: withTrinkets, forecast: { place: 4.1, error: 1.7, games: 43 } }),
      cards,
    );

    expect(view.plan).toBeNull();
    expect(view.tempo).toBeNull();
    expect(view.forecast?.place).toBeCloseTo(4.1, 2);
  });

  it('на экране выбора героя молчит: точек решения ещё нет', () => {
    const withHero: TavernAdvice = {
      ...tavern,
      heroChoice: [
        {
          option: { entityId: 98, cardId: 'BG34_HERO_001' },
          name: 'Исказительница Хроми',
          averagePosition: 3.86,
          reason: 'по статистике среднее место 3.86',
        },
      ],
    };

    const view = buildView(
      input({ tavern: withHero, forecast: { place: 4.1, error: 1.7, games: 43 } }),
      cards,
    );

    expect(view.forecast).toBeNull();
  });
});

describe('экран выбора героя', () => {
  it('открытый выбор героя показывает ранжирование, лучший помечен', () => {
    const cards2 = loadCardIndex();
    const withHeroes: TavernAdvice = {
      ...tavern,
      heroChoice: [
        {
          option: { entityId: 98, cardId: 'BG34_HERO_001' },
          name: 'Исказительница Хроми',
          averagePosition: 3.86,
          reason: 'по статистике среднее место 3.86 (17 453 партий)',
        },
        {
          option: { entityId: 99, cardId: 'НЕИЗВЕСТНЫЙ' },
          name: 'Новый герой',
          averagePosition: null,
          reason: 'статистики по герою нет',
        },
      ],
    };
    // Сущность героя-заготовки уже существует — экран включается по выбору.
    const view = buildView(input({ tavern: withHeroes }), cards2);

    expect(view.active).toBe(true);
    expect(view.header).toBe('выбор героя');
    expect(view.actions[0]?.text).toContain('Хроми');
    expect(view.actions[0]?.text).toContain('3.86');
    expect(view.actions[0]?.tone).toBe('good');
    expect(view.actions[1]?.tone).toBe('normal');
  });
});
