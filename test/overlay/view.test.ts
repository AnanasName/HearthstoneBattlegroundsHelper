import { beforeAll, describe, expect, it } from 'vitest';

import type { PositionAdvice } from '../../src/advisors/position/advisor.js';
import type { PositionTarget, ResolvedOpponent } from '../../src/advisors/position/opponent.js';
import type {
  Recommendation,
  TavernAdvice,
  ValueBreakdown,
} from '../../src/advisors/tavern/advisor.js';
import { buildView, type ViewInput } from '../../src/overlay/view.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { EMPTY_STATE, type GameState } from '../../src/state/types.js';
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
  heroPowerHasActivate: false,
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
  targetTier: 4,
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

  it('покупка на полном борде называет, кого продать', () => {
    const view = buildView(input(), cards);
    expect(view.actions[0]?.text).toContain('продав');
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
      textTribe: 0,
      textMech: 0,
      total,
      tribeMates: 0,
      textTribeMates: 0,
      textMechMates: 0,
      copiesOwned: 0,
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
