import { beforeAll, describe, expect, it } from 'vitest';

import type { FieldStrength } from '../../src/advisors/strength/strength.js';
import type { TavernAdvice } from '../../src/advisors/tavern/advisor.js';
import { buildView, type ViewInput } from '../../src/overlay/view.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { EMPTY_STATE, type GameState } from '../../src/state/types.js';
import { strengthLine } from '../../src/ui/format.js';
import { board } from '../minions.js';

/**
 * Блок силы стола: что видно игроку.
 *
 * Правила «когда считать» живут в `fieldStrengthQuestion` и проверены
 * отдельно (test/advisors/strength). Здесь проверяется только ПОДАЧА:
 * что блок не выносит вердикта, что цена поражения не печатается по горстке
 * боёв и что здоровье берётся с бронёй.
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
  heroPowerExhausted: null,
  heroPowerDisabled: false,
  heroPowerScriptData: [],
};

const state: GameState = {
  ...EMPTY_STATE,
  phase: 'tavern',
  turn: 11,
  techLevel: 4,
  hero: HERO,
  board: board([101, 102]),
};

const strength: FieldStrength = {
  percent: 62.4,
  boards: 41,
  tavernTurn: 6,
  damageOnLoss: 7.5,
  damageLosses: 23,
};

const input = (patch: Partial<ViewInput> = {}): ViewInput => ({
  state,
  tavern: null,
  thinking: false,
  position: null,
  strength,
  ...patch,
});

let cards: CardIndex;
beforeAll(() => {
  cards = loadCardIndex();
});

describe('блок силы стола', () => {
  it('показывает число, размер поля и ход', () => {
    const view = buildView(input(), cards);

    expect(view.strength?.percent).toBeCloseTo(62.4, 5);
    expect(view.strength?.boards).toBe(41);
    expect(view.strength?.tavernTurn).toBe(6);
  });

  it('первым словом ярлыка говорит, что это НЕ совет', () => {
    // Жалоба part43 про блок темпа была именно об этом: «она мне что-то
    // рекомендует? если да, это неочевидно». Второй раз тот же урок
    // повторять не надо.
    const view = buildView(input(), cards);

    expect(view.strength?.label.startsWith('не совет')).toBe(true);
  });

  it('молчит, когда силу не посчитали', () => {
    const view = buildView(input({ strength: null }), cards);

    expect(view.strength).toBeNull();
  });

  it('считает здоровье С БРОНЁЙ и полученным уроном', () => {
    // 30 − 4 + 2: это то, что реально теряется в бою (`effectiveHp`),
    // и рядом с ценой поражения только оно и имеет смысл.
    const view = buildView(input(), cards);

    expect(view.strength?.hp).toBe(28);
  });

  it('молчит без героя — цену поражения не с чем сравнить', () => {
    const view = buildView(input({ state: { ...state, hero: null } }), cards);

    expect(view.strength).toBeNull();
  });

  it('печатает цену поражения, когда за ней стоит достаточно боёв', () => {
    const view = buildView(input(), cards);

    expect(view.strength?.loss).toEqual({ hp: 7.5, losses: 23 });
  });

  it('прячет цену поражения, посчитанную по горстке боёв', () => {
    // На 13-м ходу таверны в замере всего четыре поражения, и «стоит 15 hp»
    // звучало бы там так же уверенно, как «7.5 hp» по двадцати трём.
    const view = buildView(
      input({ strength: { ...strength, damageOnLoss: 15.5, damageLosses: 4 } }),
      cards,
    );

    expect(view.strength?.loss).toBeNull();
    // Само число силы при этом остаётся: узкая выборка урона его не портит.
    expect(view.strength?.percent).toBeCloseTo(62.4, 5);
  });

  it('переживает модальный экран, как и прогноз места', () => {
    // Блок про борд и ход целиком, а не про золото и витрину, которых
    // за модалкой нет: выбор тринкета его не устаревает.
    const view = buildView(
      input({
        tavern: {
          gold: 7,
          targetTier: 4,
          recommendations: [],
          board: [],
          shop: [],
          trinkets: [{ text: 'тринкет', reason: 'повод' }],
          choice: [],
          heroChoice: [],
          trinketForecast: null,
          playPlan: [],
        } as unknown as ViewInput['tavern'],
      }),
      cards,
    );

    expect(view.strength).not.toBeNull();
  });
});

/**
 * Строка риска к подъёму таверны (part68).
 *
 * Сообщение игрока дословно: «не всегда понимаю, могу ли перейти на 6
 * безопасно, поэтому остаюсь на 5». Числа для ответа на экране были —
 * и доля боёв, и цена поражения, — но лежали в блоке силы и ни к какому
 * решению не относились. Строка их не пересчитывает: она называет
 * структурный факт и повторяет готовые числа там, где выбор и делается.
 */
describe('риск подъёма в блоке темпа', () => {
  const advice: TavernAdvice = {
    gold: 9,
    targetTier: 5,
    shopValues: [],
    trinkets: [],
    choice: [],
    playPlan: [],
    heroChoice: [],
    trinketForecast: null,
    recommendations: [],
  };
  const upgradable: GameState = { ...state, gold: 9, tavernUpgradeCost: 7, tavernUpgradeTarget: 5 };

  it('называет цену хода и повторяет числа силы, не заводя своих', () => {
    const view = buildView(input({ state: upgradable, tavern: advice }), cards);

    expect(view.tempo?.risk).toBe('если подняться и не покупать: 62 % боёв, поражение ~8 hp при ваших 28');
    // Те же числа, что в блоке силы: второго определения нет.
    expect(view.strength?.percent).toBeCloseTo(62.4, 5);
  });

  it('вердикта не выносит: ни «безопасно», ни «опасно»', () => {
    const view = buildView(input({ state: upgradable, tavern: advice }), cards);

    expect(view.tempo?.risk).not.toContain('безопас');
    expect(view.tempo?.risk).not.toContain('опасн');
    expect(view.tempo?.label).toContain('не совет');
  });

  it('без надёжной цены поражения печатает свой запас, а не выдуманное число', () => {
    const thin = { ...strength, damageOnLoss: 15.5, damageLosses: 4 };
    const view = buildView(input({ state: upgradable, tavern: advice, strength: thin }), cards);

    expect(view.tempo?.risk).toBe('если подняться и не покупать: 62 % боёв, у вас 28 hp');
  });

  it('молчит, когда подъём не по карману или чисел силы нет', () => {
    const poor = buildView(input({ state: { ...upgradable, gold: 3 }, tavern: advice }), cards);
    expect(poor.tempo?.risk).toBeNull();

    const noStrength = buildView(
      input({ state: upgradable, tavern: advice, strength: undefined }),
      cards,
    );
    expect(noStrength.tempo?.risk).toBeNull();

    // Цены подъёма в логе нет — вопроса «переходить ли» тоже нет.
    const noButton = buildView(
      input({ state: { ...upgradable, tavernUpgradeCost: null }, tavern: advice }),
      cards,
    );
    expect(noButton.tempo?.risk).toBeNull();
  });

  it('на предельном тире молчит: подниматься некуда', () => {
    const capped = buildView(
      input({ state: { ...upgradable, maxTechLevel: 4 }, tavern: advice }),
      cards,
    );
    expect(capped.tempo?.risk).toBeNull();
  });
});

describe('строка силы стола в терминале', () => {
  it('говорит то же, что блок: долю, поле, цену поражения и запас', () => {
    const line = strengthLine(strength, 28);

    expect(line).toContain('62 %');
    expect(line).toContain('6-го хода таверны');
    expect(line).toContain('поле 41 борд соперников');
    expect(line).toContain('сейчас');
    expect(line).toContain('~8 hp');
    expect(line).toContain('у вас 28');
    // Вердикта нет и в терминале.
    expect(line).toContain('не совет');
  });

  it('без надёжной цены поражения печатает только запас здоровья', () => {
    const line = strengthLine({ ...strength, damageOnLoss: 15.5, damageLosses: 4 }, 28);

    expect(line).toContain('у вас 28 hp');
    expect(line).not.toContain('поражение здесь стоит');
  });
});
