import { RACE_ALL, type CardIndex } from '../../data/cards.js';
import type { GameState, Minion, TrinketOffer } from '../../state/types.js';
import { DEFAULT_TAVERN_RULES, targetTier, type TavernRules } from './rules.js';

/**
 * TavernAdvisor: что делать в фазе таверны.
 *
 * Каждое правило — отдельная экспортированная функция от состояния и таблиц
 * правил. Так их можно проверять по одному, чего ТЗ и требует, и так видно,
 * что логика ничего не решает сама: все пороги и веса приходят из `rules.ts`.
 *
 * ## Про шкалу
 *
 * Все рекомендации сравниваются одним числом — «очками». У покупки это
 * ценность миньона, у остальных действий — насколько действие лучше
 * бездействия. Смешивать абсолютную величину с разностью не идеально,
 * но альтернатива хуже: разные шкалы у разных действий означали бы, что
 * упорядочить их между собой нельзя вовсе, а игроку нужен один список.
 *
 * ## Чего эти правила не знают
 *
 * Ровно того, чего не знает ни одна эвристика: чем покупка обернётся в бою.
 * Это умеет считать симулятор, и `verifyWithBattle` в `simulated.ts` считает —
 * но там своя цена в секундах. Эвристики остаются быстрым первым словом.
 */

export type TavernAction = 'levelUp' | 'buy' | 'play' | 'sell' | 'reroll' | 'freeze' | 'pass';

export interface Recommendation {
  readonly action: TavernAction;
  /** К какому миньону относится действие. */
  readonly minion: Minion | null;
  /** Очки: чем больше, тем настойчивее совет. */
  readonly score: number;
  /** Во сколько золота обойдётся. */
  readonly cost: number;
  /** Нужно ли освободить место на борде. */
  readonly requiresSlot: boolean;
  /**
   * Кого продать, чтобы место появилось.
   *
   * Заполняется у покупок при полном борде. Без этого совет «купить, борд
   * полон, нужно продать» перекладывает на игрока ровно ту работу, ради
   * которой советник и нужен, — а отдельная рекомендация «продать» стоит
   * в списке ниже трёх покупок и на глаза не попадается.
   */
  readonly sellFirst: Minion | null;
  /** Обоснование с числами — то, что читает человек. */
  readonly reason: string;
}

/** Из чего сложилась ценность миньона. Для демо и для разбора спорных советов. */
export interface ValueBreakdown {
  readonly techLevel: number;
  readonly stats: number;
  readonly tribe: number;
  readonly keywords: number;
  readonly copies: number;
  readonly golden: number;
  /** Экономический эффект, распознанный по тексту карты. */
  readonly economy: number;
  readonly total: number;
  /** Сколько своих того же племени уже на борде. */
  readonly tribeMates: number;
  /** Сколько таких же карт уже есть на борде и в руке. */
  readonly copiesOwned: number;
}

/** Один вариант открытого предложения тринкетов с оценкой. */
export interface TrinketAdvice {
  readonly offer: TrinketOffer;
  readonly name: string;
  /** Своих миньонов из племён, которые текст тринкета называет словами. */
  readonly tribeMinions: number;
  readonly reason: string;
}

export interface TavernAdvice {
  /** Рекомендации по убыванию очков. Первая — то, что советуем сделать. */
  readonly recommendations: readonly Recommendation[];
  readonly gold: number;
  /** Какой тир полагается по таблице на этом ходу. */
  readonly targetTier: number;
  /** Ценность каждого миньона витрины — в том же порядке, что и магазин. */
  readonly shopValues: readonly { readonly minion: Minion; readonly value: ValueBreakdown }[];
  /**
   * Открытое предложение тринкетов, лучший первым. Пусто, когда выбора нет.
   *
   * Отдельным полем, а не рекомендацией в общем списке: в игре это модальный
   * выбор со своим экраном, он не соревнуется с покупками за золото.
   */
  readonly trinkets: readonly TrinketAdvice[];
}

export interface TavernAdvisorDeps {
  readonly cards: CardIndex;
}

/** Племена миньона по справочнику. Пустой список у нейтральных. */
function racesOf(minion: Minion, cards: CardIndex): readonly string[] {
  return cards.info(minion.cardId)?.races ?? [];
}

/**
 * Сколько своих миньонов делят племя с этим.
 *
 * Амальгамы (`ALL`) считаются своими для любого племени — и с той, и с другой
 * стороны сравнения.
 */
export function tribeMates(candidate: Minion, board: readonly Minion[], cards: CardIndex): number {
  const mine = racesOf(candidate, cards);
  if (mine.length === 0) return 0;

  return board.filter((m) => {
    const theirs = racesOf(m, cards);
    if (theirs.length === 0) return false;
    if (mine.includes(RACE_ALL) || theirs.includes(RACE_ALL)) return true;
    return theirs.some((r) => mine.includes(r));
  }).length;
}

/**
 * Сколько таких же карт уже есть на борде и в руке.
 *
 * Считаются только незолотые копии: тройка собирается из трёх обычных,
 * золотой с обычными не складывается.
 *
 * Сам кандидат из счёта исключается по entityId. Для витрины это ничего
 * не меняет — её миньонов в руке нет, — а вот карта ИЗ РУКИ без этого
 * считала бы копией саму себя и получала бонус «вторая копия» на ровном месте.
 */
export function copiesOwned(candidate: Minion, state: GameState): number {
  if (candidate.golden) return 0;
  const same = (m: Minion): boolean =>
    m.cardId === candidate.cardId && !m.golden && m.entityId !== candidate.entityId;
  return state.board.filter(same).length + state.hand.filter(same).length;
}

/** Ценность миньона: во что складываются веса из таблицы правил. */
export function minionValue(
  candidate: Minion,
  state: GameState,
  { cards }: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): ValueBreakdown {
  const w = rules.value;
  const info = cards.info(candidate.cardId);

  const tech = (candidate.techLevel ?? info?.techLevel ?? 1) * w.perTechLevel;
  const stats = ((candidate.attack ?? 0) + (candidate.health ?? 0)) * w.perStatPoint;

  const mates = tribeMates(candidate, state.board, cards);
  const tribe = mates * w.perTribeMate;

  const keywords =
    (candidate.taunt ? w.taunt : 0) +
    (candidate.divineShield ? w.divineShield : 0) +
    (candidate.poisonous || candidate.venomous ? w.poisonous : 0) +
    (candidate.windfury ? w.windfury : 0) +
    (candidate.reborn ? w.reborn : 0);

  const owned = copiesOwned(candidate, state);
  // Больше двух копий бонус не растёт: тройка собирается ровно из трёх.
  const copies = rules.copiesBonus[Math.min(owned, rules.copiesBonus.length - 1)] ?? 0;

  const golden = candidate.golden ? w.golden : 0;

  // Экономика видна только в тексте карты: River Skipper 1/1 по статам
  // мусор, а при продаже возвращает миньона. Шаблоны — из реальных текстов
  // пула, вес честно помечен как непроверяемый ближайшим боем.
  const text = info?.text ?? '';
  const economy =
    text !== '' && rules.economyTextWords.some((word) => new RegExp(word, 'i').test(text))
      ? w.economy
      : 0;

  return {
    techLevel: tech,
    stats,
    tribe,
    keywords,
    copies,
    golden,
    economy,
    total: tech + stats + tribe + keywords + copies + golden + economy,
    tribeMates: mates,
    copiesOwned: owned,
  };
}

/** Здоровье с бронёй — то, чем игрок реально расплачивается за слабый ход. */
function effectiveHp(state: GameState): number {
  const hero = state.hero;
  if (hero === null) return 0;
  return (hero.health ?? 0) - hero.damage + hero.armor;
}

/**
 * Правило подъёма таверны.
 *
 * Подъём — это ход без покупки, то есть заведомо более слабый бой. На полном
 * здоровье такой размен окупается будущим доступом к сильным миньонам,
 * на остатках здоровья он и есть проигрыш партии. Поэтому порог по здоровью,
 * а не только по золоту.
 *
 * ## Почему очки привязаны к лучшей покупке
 *
 * У покупки очки — ценность миньона, она к середине партии доходит до 20+.
 * Прежние очки подъёма («отставание × 3», максимум ~9) жили в другой шкале
 * и проигрывали любой покупке всегда: за девять ходов партии подъём попадал
 * в советы один раз. Число можно было бы подкрутить, но честнее признать
 * само правило: когда таверна отстаёт от графика и здоровье позволяет,
 * подъём ВАЖНЕЕ покупок — поэтому его очки ставятся выше лучшей из них
 * ровно на величину отставания.
 *
 * Одно исключение: если золота хватает только на что-то одно, тройка
 * важнее подъёма — она даёт золотого миньона и открытие карты. Когда золота
 * хватает на обоих, подъём всё равно идёт первым: сыгранная ПОСЛЕ подъёма
 * тройка открывает карту уже с нового тира.
 */
export function levelUpRule(
  state: GameState,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
  buys: readonly Recommendation[] = [],
): Recommendation | null {
  const cost = state.tavernUpgradeCost;
  const target = state.tavernUpgradeTarget;
  if (cost === null || target === null) return null;
  if (state.maxTechLevel !== null && state.techLevel >= state.maxTechLevel) return null;
  if (cost > state.gold) return null;

  const hp = effectiveHp(state);
  if (hp < rules.levellingHpFloor) {
    return {
      action: 'levelUp',
      minion: null,
      score: 0,
      cost,
      requiresSlot: false,
      sellFirst: null,
      reason:
        `поднять таверну можно за ${String(cost)}, но здоровья ${String(hp)} ` +
        `при пороге ${String(rules.levellingHpFloor)} — ход без покупки сейчас дороже тира`,
    };
  }

  const wanted = targetTier(state.turn, rules);
  const behind = Math.max(0, wanted - state.techLevel);

  // Расширение витрины — отдельная ценность подъёма: на чётных тирах
  // миньонов в ней становится больше (замерено по фикстурам, 3/4/4/5/5).
  const widens =
    (rules.shopSizeByTier[target] ?? 0) > (rules.shopSizeByTier[state.techLevel] ?? 0);
  const widerShop = widens ? `, витрина расширится до ${String(rules.shopSizeByTier[target])}` : '';

  let score = behind * rules.levellingUrgencyPerTier;
  if (behind > 0 && buys.length > 0) {
    const bestBuy = Math.max(...buys.map((b) => b.score));
    const triple = buys
      .filter((b) => b.minion !== null && copiesOwned(b.minion, state) >= 2)
      .reduce((best: number | null, b) => (best === null || b.score > best ? b.score : best), null);
    const affordBoth = state.gold >= cost + rules.minionCost;

    score =
      triple !== null && !affordBoth
        ? // Золота на одно: тройку упускать нельзя, подъём сразу за ней.
          triple - 0.5
        : bestBuy + behind * rules.levellingUrgencyPerTier;
  }

  return {
    action: 'levelUp',
    minion: null,
    score,
    cost,
    requiresSlot: false,
    sellFirst: null,
    reason:
      behind > 0
        ? `таверна ${String(state.techLevel)} при ожидаемых ${String(wanted)} к ходу ${String(state.turn)}` +
          `, подъём до ${String(target)} стоит ${String(cost)} из ${String(state.gold)}${widerShop}`
        : `таверна ${String(state.techLevel)} и так по графику, подъём до ${String(target)} за ${String(cost)} — на опережение${widerShop}`,
  };
}

/**
 * Ценность своего миньона — против ОСТАЛЬНОГО борда, а не против пустого.
 *
 * Разница не косметическая. Кандидат из витрины получает племенную синергию
 * от всех семи своих, а его конкурент с борда, посчитанный в пустоте, — ноль,
 * и любой чужой выглядит выгоднее любого своего. На бордах одного племени
 * это давало советы продавать заведомо не того.
 */
function ownValue(
  m: Minion,
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): number {
  const rest = state.board.filter((x) => x.entityId !== m.entityId);
  const value = minionValue(m, { ...state, board: rest }, deps, rules);
  // Бонус за копии — про приобретение, а не про удержание: он оценивает, что
  // покупка соберёт тройку. У миньона, который уже на борде, ничего собирать
  // не надо, и оставленный бонус делает своих неотчуждаемыми — борд из семи
  // одинаковых токенов оценивался бы дороже любой витрины.
  return value.total - value.copies;
}

/** Слабейший свой — кандидат на продажу, когда борд полон. */
function weakestOwn(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): { minion: Minion; value: number } | null {
  if (state.board.length === 0) return null;
  return state.board
    .map((m) => ({ minion: m, value: ownValue(m, state, deps, rules) }))
    .reduce((a, b) => (b.value < a.value ? b : a));
}

/** Правило покупки: по рекомендации на каждого миньона витрины, что по карману. */
export function buyRules(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation[] {
  const full = state.board.length >= rules.boardSize;
  const victim = full ? weakestOwn(state, deps, rules) : null;

  return state.shop
    .filter(() => rules.minionCost <= state.gold)
    .map((minion) => {
      const value = minionValue(minion, state, deps, rules);
      const name = deps.cards.info(minion.cardId)?.name ?? minion.cardId;

      const notes: string[] = [];
      if (value.copiesOwned >= 2) notes.push('собирает тройку');
      else if (value.copiesOwned === 1) notes.push('вторая копия');
      if (value.tribeMates > 0) notes.push(`своих по племени ${String(value.tribeMates)}`);
      if (value.economy > 0) notes.push('вернёт часть цены при продаже');
      if (minion.golden) notes.push('золотой');
      if (victim !== null) {
        const victimName = deps.cards.info(victim.minion.cardId)?.name ?? victim.minion.cardId;
        notes.push(`борд полон, продать ${victimName} (${victim.value.toFixed(1)})`);
      } else if (full) {
        notes.push('борд полон');
      }

      // Тир берётся с тем же запасным вариантом, что и в оценке: у миньона
      // витрины тега `TECH_LEVEL` может ещё не быть, и подпись «тир ?» рядом
      // с посчитанной по тиру ценностью выглядела бы противоречием.
      const tier = minion.techLevel ?? deps.cards.info(minion.cardId)?.techLevel ?? null;

      return {
        action: 'buy' as const,
        minion,
        score: value.total,
        cost: rules.minionCost,
        requiresSlot: full,
        sellFirst: victim?.minion ?? null,
        reason:
          `${name} ${String(minion.attack ?? '?')}/${String(minion.health ?? '?')} ` +
          `тир ${tier === null ? '?' : String(tier)}, ценность ${value.total.toFixed(1)}` +
          (notes.length > 0 ? ` — ${notes.join(', ')}` : ''),
      };
    });
}

/**
 * Правило розыгрыша из руки.
 *
 * Купленный миньон попадает в руку, а бой играет только борд: карта, забытая
 * в руке, — это потраченное золото без миньона в бою. Пока на борде есть
 * место, разыграть сильнее руки почти всегда правильно; на полном борде —
 * только через продажу кого-то слабее.
 *
 * Ценность считается той же функцией, что у витрины, поэтому «разыграть»
 * и «купить» сравнимы напрямую. Розыгрыш при этом бесплатный.
 */
export function playRules(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation[] {
  const full = state.board.length >= rules.boardSize;
  const victim = full ? weakestOwn(state, deps, rules) : null;

  return state.hand.flatMap((minion) => {
    const value = minionValue(minion, state, deps, rules);

    // На полном борде розыгрыш идёт через продажу, и жертва обязана быть
    // слабее — менять равного на равного с доплатой хода смысла нет.
    if (full && (victim === null || victim.value >= value.total)) return [];

    const name = deps.cards.info(minion.cardId)?.name ?? minion.cardId;
    const notes: string[] = [];
    if (value.copiesOwned >= 2) notes.push('собирает тройку');
    else if (value.copiesOwned === 1) notes.push('вторая копия');
    if (minion.golden) notes.push('золотой');
    if (value.tribeMates > 0) notes.push(`своих по племени ${String(value.tribeMates)}`);
    if (victim !== null) {
      const victimName = deps.cards.info(victim.minion.cardId)?.name ?? victim.minion.cardId;
      notes.push(`борд полон, продать ${victimName} (${victim.value.toFixed(1)})`);
    }

    return [
      {
        action: 'play' as const,
        minion,
        score: value.total,
        cost: 0,
        requiresSlot: full,
        sellFirst: victim?.minion ?? null,
        reason:
          `${name} ${String(minion.attack ?? '?')}/${String(minion.health ?? '?')} из руки, ` +
          `ценность ${value.total.toFixed(1)}` +
          (notes.length > 0 ? ` — ${notes.join(', ')}` : ''),
      },
    ];
  });
}

/**
 * Правило продажи.
 *
 * Осмысленно только при полном борде: миньона продают, чтобы освободить место
 * под явно лучшего. Порог не даёт советовать размен ради полутора очков —
 * продажа возвращает одно золото из трёх потраченных, и просто так она убыток.
 */
export function sellRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  if (state.board.length < rules.boardSize) return null;
  if (state.shop.length === 0 || rules.minionCost > state.gold) return null;

  const best = state.shop
    .map((m) => ({ minion: m, value: minionValue(m, state, deps, rules).total }))
    .reduce((a, b) => (b.value > a.value ? b : a));

  const worst = weakestOwn(state, deps, rules);
  if (worst === null) return null;

  const gain = best.value - worst.value;
  if (gain <= rules.sellMargin) return null;

  const worstName = deps.cards.info(worst.minion.cardId)?.name ?? worst.minion.cardId;
  const bestName = deps.cards.info(best.minion.cardId)?.name ?? best.minion.cardId;

  return {
    action: 'sell',
    minion: worst.minion,
    score: gain - rules.sellMargin,
    cost: 0,
    requiresSlot: false,
    sellFirst: null,
    reason:
      `борд полон; ${worstName} слабейший (${worst.value.toFixed(1)}), ` +
      `а ${bestName} в витрине стоит ${best.value.toFixed(1)} — разница ${gain.toFixed(1)}`,
  };
}

/**
 * Правило обновления витрины.
 *
 * Советуется, когда покупать нечего: лучший кандидат ниже порога. Отдельно
 * учтено, что реролл нельзя советовать, если золото копится на подъём —
 * иначе совет ворует ход у более важного действия.
 */
export function rerollRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  if (state.gold < rules.rerollCost) return null;

  const best =
    state.shop.length === 0
      ? 0
      : Math.max(...state.shop.map((m) => minionValue(m, state, deps, rules).total));

  if (best >= rules.rerollWhenBestBelow) return null;

  // Копим на подъём: если после реролла на него уже не хватит, а сейчас
  // хватает — реролл дороже, чем кажется.
  const upgrade = state.tavernUpgradeCost;
  if (upgrade !== null && state.gold >= upgrade && state.gold - rules.rerollCost < upgrade) {
    return null;
  }

  return {
    action: 'reroll',
    minion: null,
    score: rules.rerollWhenBestBelow - best,
    cost: rules.rerollCost,
    requiresSlot: false,
    sellFirst: null,
    reason:
      `лучшее в витрине стоит ${best.toFixed(1)} при пороге ${String(rules.rerollWhenBestBelow)} — ` +
      `покупать нечего, обновление стоит ${String(rules.rerollCost)}`,
  };
}

/**
 * Правило заморозки.
 *
 * Незамороженная витрина обновляется в начале хода БЕСПЛАТНО. Значит,
 * заморозка не «сохраняет хорошее», а отказывается от нового даром, и голые
 * статы её не окупают: свежая витрина в среднем не хуже нынешней. Окупает
 * только то, чего свежая витрина не даст, — копия под тройку или миньон
 * племени, которое уже собирается на борде. И только когда купить это
 * прямо сейчас не хватает золота: что по карману, надо просто покупать.
 */
export function freezeRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  if (state.shop.length === 0) return null;
  if (state.shop.every((m) => m.frozen)) return null;

  const affordable = Math.floor(state.gold / rules.minionCost);
  const valued = state.shop
    .map((m) => {
      const value = minionValue(m, state, deps, rules);
      return { minion: m, value: value.total, copies: value.copiesOwned, mates: value.tribeMates };
    })
    .sort((a, b) => b.value - a.value);

  // Ценное, до чего в этом ходу руки не дойдут: денег хватает не на всех.
  const keepers = valued
    .slice(affordable)
    .filter(
      (v) =>
        v.value >= rules.freeze.minValue &&
        (v.copies >= 1 || v.mates >= rules.freeze.minTribeMates),
    );
  const best = keepers[0];
  if (best === undefined) return null;

  const name = deps.cards.info(best.minion.cardId)?.name ?? best.minion.cardId;
  const why =
    best.copies >= 2
      ? 'третья копия под тройку'
      : best.copies === 1
        ? 'вторая копия'
        : `своих по племени ${String(best.mates)}`;

  return {
    action: 'freeze',
    minion: best.minion,
    score: best.value - rules.freeze.minValue,
    cost: 0,
    requiresSlot: false,
    sellFirst: null,
    reason:
      `${name} — ${why}, а золота ${String(state.gold)} хватает лишь на ` +
      `${String(affordable)} покупок; свежая витрина такого не обещает`,
  };
}

/**
 * Совет по выбору тринкета.
 *
 * Честная граница возможностей: у тринкета нет ни статов, ни племени в данных —
 * только текст. Из текста извлекаются упомянутые словами племена
 * (таблица `trinketTribeWords`), и варианты ранжируются по числу своих
 * миньонов этих племён. Про эффекты вне племён совет прямо говорит,
 * что оценить их не берётся, — это лучше выдуманного рейтинга.
 */
export function trinketAdvice(
  state: GameState,
  { cards }: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): TrinketAdvice[] {
  if (state.trinketOffer.length === 0) return [];

  const scored = state.trinketOffer.map((offer) => {
    const info = cards.info(offer.cardId);
    const name = info?.name ?? offer.cardId;
    const text = info?.text ?? '';

    const tribes = Object.entries(rules.trinketTribeWords)
      .filter(([, word]) => new RegExp(`\\b(?:${word})\\b`, 'i').test(text))
      .map(([race]) => race);

    const tribeMinions =
      tribes.length === 0
        ? 0
        : state.board.filter((m) => {
            const races = racesOf(m, cards);
            return races.includes(RACE_ALL) || races.some((r) => tribes.includes(r));
          }).length;

    return {
      offer,
      name,
      tribeMinions,
      reason:
        tribes.length === 0
          ? 'эффект вне племён — оценить не берёмся'
          : tribeMinions === 0
            ? `для племени ${tribes.join('/')}, а своих таких нет`
            : `упоминает ${tribes.join('/')} — своих ${String(tribeMinions)}`,
    };
  });

  return scored.sort((a, b) => b.tribeMinions - a.tribeMinions);
}

/**
 * Совет по таверне целиком.
 *
 * Возвращает `null` вне фазы таверны: советовать покупки во время боя
 * бессмысленно, а притворяться, что состояние подходит, — вредно.
 */
export function adviseTavern(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): TavernAdvice | null {
  if (state.phase !== 'tavern' || state.hero === null) return null;

  const buys = buyRules(state, deps, rules);
  const recommendations: Recommendation[] = [
    ...buys,
    ...playRules(state, deps, rules),
    levelUpRule(state, rules, buys),
    sellRule(state, deps, rules),
    rerollRule(state, deps, rules),
    freezeRule(state, deps, rules),
    {
      action: 'pass',
      minion: null,
      score: 0,
      cost: 0,
      requiresSlot: false,
      sellFirst: null,
      reason: 'ничего не делать и оставить золото',
    },
  ].filter((r): r is Recommendation => r !== null);

  return {
    recommendations: recommendations.sort((a, b) => b.score - a.score),
    gold: state.gold,
    targetTier: targetTier(state.turn, rules),
    shopValues: state.shop.map((minion) => ({
      minion,
      value: minionValue(minion, state, deps, rules),
    })),
    trinkets: trinketAdvice(state, deps, rules),
  };
}
