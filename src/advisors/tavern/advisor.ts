import { RACE_ALL, type CardIndex } from '../../data/cards.js';
import { sharedBgStats, type BgStats } from '../../data/bgStats.js';
import type { ChoiceOption, GameState, Minion, TrinketOffer } from '../../state/types.js';
import { DEFAULT_TAVERN_RULES, targetTier, tavernTurnOf, type TavernRules } from './rules.js';

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
 * Это умеет считать симулятор — `checkBuysWithBattle` в `simulated.ts`
 * досчитывает верхние покупки в живом воркере, — но там своя цена
 * в полсекунды. Эвристики остаются быстрым первым словом.
 */

export type TavernAction =
  | 'levelUp'
  | 'buy'
  | 'play'
  | 'sell'
  | 'reroll'
  | 'freeze'
  | 'heroPower'
  | 'darkGift'
  | 'activate'
  | 'spin'
  | 'pass';

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
  /**
   * К кому примагнитить магнитного миньона.
   *
   * Заполняется у магнитных механизмов при полном борде: примагничивание
   * не занимает места, и продавать ради него никого не нужно — на что
   * игрок и указал. Цель — самый крупный свой мех: усиление достаётся
   * тому, кто дольше живёт в бою.
   */
  readonly magnetizeTo?: Minion | null;
  /** Заклинание, к которому относится совет «разыграть». У миньонов пусто. */
  readonly spellCardId?: string | null;
  /**
   * Цель заклинания-усиления — свой миньон, на которого его кастовать.
   *
   * Отдельным полем, а не только словами в reason: оверлей показывает
   * короткую строку действия, и совет «РАЗЫГРАТЬ Fortify» без цели
   * перекладывал выбор на игрока (part12).
   */
  readonly targetMinion?: Minion | null;
  /**
   * Цель — магнит-ХРАНИТЕЛЬ, и совет тратит его дневной заряд («The first
   * Spellcraft spell … each turn is permanent»).
   *
   * Нужно ПЛАНУ хода: заряд один на ход, и второе чародейское заклинание
   * той же цепочки постоянным уже не станет. Без пометки план обещал бы
   * постоянство дважды — тихо и неверно (part21).
   */
  readonly spendsMagnetCharge?: boolean;
  /**
   * Какую ветвь брать у модального заклинания «Choose One».
   *
   * Отдельным полем по той же причине, что и цель: оверлей показывает
   * короткую строку действия, а «Alliance Flag» без ветви оставлял игрока
   * с выбором «Булава или Щит» наедине (part19, ход 7). Список из двух
   * элементов означает, что ветви равны по нашей шкале и выбор честно
   * возвращается игроку.
   */
  readonly spellBranches?: readonly SpellBranch[];
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
  /** Боевой эффект из текста: ралли, призывы — в бою сильнее статов. */
  readonly battle: number;
  /** Синергия с племенем, которое карта называет словами, не входя в него. */
  readonly textTribe: number;
  /** Синергия с механикой, названной словами в тексте (хрипы у Titus). */
  readonly textMech: number;
  /** Связь по имени карты: текст называет карту своих — или их тексты его. */
  readonly namedCard: number;
  /** Магнит заклинаний: выгода от заклинаний руки, применённых к нему. */
  readonly spellMagnet: number;
  /** Удвоитель механики на борде: лишняя принесённая карта по курсу. */
  readonly doubler: number;
  /** Синергия с СИЛОЙ ГЕРОЯ: её текст называет племя кандидата или продажу. */
  readonly heroPower: number;
  readonly total: number;
  /** Сколько своих того же племени уже на борде. */
  readonly tribeMates: number;
  /** Сколько своих миньонов племён, названных в тексте карты. */
  readonly textTribeMates: number;
  /** Сколько своих миньонов с механиками, названными в тексте карты. */
  readonly textMechMates: number;
  /** Сколько своих связано с картой по имени (в обе стороны). */
  readonly namedCardMates: number;
  /** Сколько таких же карт уже есть на борде и в руке. */
  readonly copiesOwned: number;
}

/** Один вариант открытого предложения тринкетов с оценкой. */
export interface TrinketAdvice {
  readonly offer: TrinketOffer;
  readonly name: string;
  /** Своих миньонов из племён, которые текст тринкета называет словами. */
  readonly tribeMinions: number;
  /** Среднее место по статистике Firestone. `null` — нет данных. */
  readonly averagePlacement?: number | null;
  readonly reason: string;
}

/** Один вариант выбора героя со статистикой мест. */
export interface HeroChoiceAdvice {
  readonly option: ChoiceOption;
  readonly name: string;
  /** Среднее место по статистике Firestone. `null` — нет данных. */
  readonly averagePosition: number | null;
  readonly reason: string;
}

/**
 * Совет по выбору героя — ранжирование статистикой мест.
 *
 * Своих правил ценности у героев нет и не выдумывается: сила героя,
 * стартовая броня и кривая — это ровно то, что уже свёрнуто в среднем месте
 * по реальным партиям (снапшот Firestone, `npm run update:bgstats`).
 * Скины приводятся к базовой карте внутри справочника статистики.
 * Без снапшота честно говорится «статистики нет».
 */
export function heroChoiceAdvice(
  state: GameState,
  deps: TavernAdvisorDeps,
): HeroChoiceAdvice[] {
  const choice = state.heroChoice;
  if (choice === null || choice.options.length === 0) return [];
  const stats = bgStatsOf(deps);

  return choice.options
    .map((option) => {
      const stat = stats?.hero(option.cardId) ?? null;
      return {
        option,
        name: deps.cards.info(option.cardId)?.name ?? option.cardId,
        averagePosition: stat?.averagePosition ?? null,
        reason:
          stat === null
            ? 'статистики по герою нет'
            : `по статистике среднее место ${stat.averagePosition.toFixed(2)}` +
              ` (${stat.dataPoints.toLocaleString('ru-RU')} партий)`,
      };
    })
    .sort((a, b) => (a.averagePosition ?? 9) - (b.averagePosition ?? 9));
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
  /**
   * Открытый выбор «возьмите одно из» с оценками, лучший первым.
   * Пусто, когда выбора на экране нет.
   */
  readonly choice: readonly ChoiceAdvice[];
  /**
   * План розыгрыша на ход, когда разыграть стоит больше одной карты.
   * Пусто, когда карт меньше двух — там хватает обычной рекомендации.
   */
  readonly playPlan: readonly PlanStep[];
  /**
   * Открытый выбор героя в начале партии, лучший по статистике первым.
   * Пусто всю остальную партию.
   */
  readonly heroChoice: readonly HeroChoiceAdvice[];
  /**
   * Напоминание за ход до предложения тринкетов (тьюторинг, docs/jeefhs.md).
   * `null` всю остальную партию.
   */
  readonly trinketForecast: string | null;
}

export interface TavernAdvisorDeps {
  readonly cards: CardIndex;
  /**
   * Статистика мест из снапшота Firestone (`npm run update:bgstats`).
   *
   * Необязательна: `undefined` — взять общий снапшот с диска (его может
   * не быть, тогда советы живут без статистики), `null` — явно без неё
   * (тесты правил, которым статистика мешала бы).
   */
  readonly bgStats?: BgStats | null;
}

/** Статистика: из зависимостей или общий снапшот с диска. */
function bgStatsOf(deps: TavernAdvisorDeps): BgStats | null {
  return deps.bgStats === undefined ? sharedBgStats() : deps.bgStats;
}

/** Племена миньона по справочнику. Пустой список у нейтральных. */
function racesOf(minion: Minion, cards: CardIndex): readonly string[] {
  return cards.info(minion.cardId)?.races ?? [];
}

/**
 * Племена, которые текст карты называет словами, БЕЗ собственных племён карты.
 *
 * Собственные исключаются, чтобы не считать одну синергию дважды: Turbo
 * Hogrider — свинобраз, называющий в тексте свинобразов же. А вот Kangor's
 * Apprentice — миньон без племени с текстом про мехов, и эта связь видна
 * только отсюда.
 */
function textTribesOf(cardId: string, cards: CardIndex, rules: TavernRules): string[] {
  const info = cards.info(cardId);
  const text = info?.text ?? '';
  if (text === '') return [];
  const own = new Set(info?.races ?? []);
  return Object.entries(rules.tribeTextWords)
    .filter(([race, word]) => !own.has(race) && new RegExp(`\\b(?:${word})\\b`, 'i').test(text))
    .map(([race]) => race);
}

/**
 * Механики, которые текст карты называет словами, БЕЗ собственных механик карты.
 *
 * Та же логика, что у textTribesOf: Buzzing Vermin сам хрип и в тексте пишет
 * «Deathrattle:» — это не синергия, а описание себя. А вот Titus Rivendare
 * («Your Deathrattles trigger an extra time», механика AURA) и Deathstrider
 * («After a friendly Rally minion attacks, trigger your left-most
 * Deathrattle», TRIGGER_VISUAL) — усилители чужих механик, и без этой связи
 * оба на борде хрипов были голыми статами (part15, ход 17: советник
 * предложил продать Titus ради Wolf Pup 3/5).
 */
function textMechanicsOf(cardId: string, cards: CardIndex, rules: TavernRules): string[] {
  const info = cards.info(cardId);
  const text = info?.text ?? '';
  if (text === '') return [];
  const own = new Set(info?.mechanics ?? []);
  return Object.entries(rules.mechanicTextWords)
    .filter(([mech, word]) => !own.has(mech) && new RegExp(`\\b(?:${word})\\b`, 'i').test(text))
    .map(([mech]) => mech);
}

/**
 * Свои миньоны, связанные с кандидатом МЕХАНИКОЙ, — в обе стороны.
 *
 * Прямая сторона: текст кандидата называет механику, а свои её несут
 * (Titus Rivendare «Your Deathrattles trigger an extra time» на борде
 * хрипов, part15).
 *
 * Обратная сторона: кандидат НЕСЁТ механику, а тексты своих её называют.
 * Случай part18 (ход 17): борд наг на заклинаниях — Abyssal Bruiser
 * («+{0}/+{1} for each Tavern spell you've cast»), Fleeing Fugitive
 * («Whenever you cast a spell on this…»), — а в витрине Deep-Sea Angler,
 * нага со Spellcraft, то есть источник этих самых заклинаний. Связь была
 * невидима, и советник предпочёл ему демона на два тира выше, «который
 * совсем не подходит композиции», — на что игрок и указал. Двусторонность
 * здесь та же, что у связи по имени карты (`namedCardMates`).
 *
 * Миньон, который сам несёт механику и сам же её называет («Spellcraft: …»),
 * в обратную сторону не считается: он производитель, а не потребитель, —
 * то же исключение, что у собственной механики в прямую сторону.
 */
function boardMatesOfMechanics(
  mechanics: readonly string[],
  candidate: Minion,
  board: readonly Minion[],
  cards: CardIndex,
  rules: TavernRules,
): number {
  const own = cards.info(candidate.cardId)?.mechanics ?? [];
  const named = Object.entries(rules.mechanicTextWords).filter(([mech]) => own.includes(mech));

  return board.filter((m) => {
    const info = cards.info(m.cardId);
    const theirs = info?.mechanics ?? [];
    if (mechanics.some((mech) => theirs.includes(mech))) return true;

    const text = info?.text ?? '';
    if (text === '') return false;
    return named.some(
      ([mech, word]) => !theirs.includes(mech) && new RegExp(`\\b(?:${word})\\b`, 'i').test(text),
    );
  }).length;
}

/**
 * Свои миньоны, связанные с кандидатом ИМЕНЕМ карты, — в обе стороны:
 * текст кандидата называет их карту, или их текст называет его.
 *
 * Automaton Portrait («…summon an Ancestral Automaton») при своих
 * автоматонах — прямой множитель их роста; и наоборот, автоматон
 * из витрины ценнее при портрете на борде. Имена и тексты — из снапшота,
 * не выдуманная таблица пар. Копии (одно имя) не считаются — у них
 * своя ветка тройки.
 *
 * Пробелы в текстах ненадёжны (урок part16: переносы строк посреди
 * предложения), поэтому обе стороны сравнения приводятся к одиночным
 * пробелам. Имена короче шести символов не ищутся: односложное имя
 * в тексте — совпадение случайных слов, а не связь.
 */
function namedCardMates(candidate: Minion, board: readonly Minion[], cards: CardIndex): number {
  const info = cards.info(candidate.cardId);
  if (info === null) return 0;
  const flatten = (text: string | null): string => (text ?? '').replace(/\s+/g, ' ');
  const names = (name: string, text: string): boolean => name.length >= 6 && text.includes(name);
  const candidateText = flatten(info.text);

  return board.filter((m) => {
    if (m.entityId === candidate.entityId) return false;
    const theirs = cards.info(m.cardId);
    if (theirs === null || theirs.name === info.name) return false;
    return names(theirs.name, candidateText) || names(info.name, flatten(theirs.text));
  }).length;
}

/**
 * Механики, которые УДВАИВАЕТ хотя бы один свой миньон на борде.
 *
 * Удвоитель — читаемый факт: его текст говорит «trigger twice» / «trigger
 * an extra time» и называет механику словом. В пуле таких ровно трое, и они
 * делят три механики между собой (Бранн — кличи, Titus — хрипы, Drakkari —
 * конец хода). Собственный текст кандидата тут ни при чём: удваивает ЧУЖОЙ
 * миньон, стоящий на борде.
 */
function doubledMechanicsOnBoard(
  board: readonly Minion[],
  candidate: Minion,
  cards: CardIndex,
  rules: TavernRules,
): string[] {
  const doubled = new Set<string>();
  for (const m of board) {
    if (m.entityId === candidate.entityId) continue;
    const text = cards.info(m.cardId)?.text ?? '';
    if (text === '') continue;
    if (!rules.mechanicDoublerWords.some((w) => new RegExp(w, 'i').test(text))) continue;
    for (const [mech, word] of Object.entries(rules.doubledMechanicWords)) {
      if (new RegExp(`\\b(?:${word})\\b`, 'i').test(text)) doubled.add(mech);
    }
  }
  return [...doubled];
}

/** Сколько своих миньонов принадлежит хотя бы одному из племён. */
function boardMatesOfTribes(
  tribes: readonly string[],
  board: readonly Minion[],
  cards: CardIndex,
): number {
  if (tribes.length === 0) return 0;
  return board.filter((m) => {
    const races = racesOf(m, cards);
    return races.includes(RACE_ALL) || races.some((r) => tribes.includes(r));
  }).length;
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

  // Щит, вихрь и перерождение усиливают САМО тело и не могут стоить дороже
  // него: щит на 2/1 спасает полтора очка статов, а не три. Найдено сверкой
  // с симулятором (part7, ход 3): Crackling Cyclone 2/1 со щитом и вихрем
  // советовался против Molten Rock 3/3 при цене промаха 50 п.п. Провокация
  // и яд телом не меряются: они меняют чужое поведение и чужие тела.
  const attackPoints = (candidate.attack ?? 0) * w.perStatPoint;
  const keywords =
    (candidate.taunt ? w.taunt : 0) +
    (candidate.divineShield ? Math.min(w.divineShield, stats) : 0) +
    (candidate.poisonous || candidate.venomous ? w.poisonous : 0) +
    (candidate.windfury ? Math.min(w.windfury, attackPoints) : 0) +
    (candidate.reborn ? Math.min(w.reborn, stats) : 0);

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

  // Боевой эффект из текста: ралли и призывы делают миньона в бою сильнее
  // его статов, и сверка с симулятором показала это ценой до 100 п.п.
  // (part6, ход 1: Flittering Bat с «Rally: Summon a Beast»).
  //
  // Оговорка part14 (ход 21): эффект «вашим <племени>» («Rally: Your Undead
  // have +1 Attack») пуст, когда своих этого племени нет, — на борде
  // элементалей нежить-ралли не делает ничего. Племя после «your» ищется
  // той же таблицей слов; призывов («Summon a Beast») это не касается —
  // призыв приносит тело независимо от борда.
  const battleMatch =
    text !== '' && rules.battleTextWords.some((word) => new RegExp(word, 'i').test(text));
  let battle = 0;
  if (battleMatch) {
    const yourRaces = Object.entries(rules.tribeTextWords)
      .filter(([, word]) => new RegExp(`\\byour\\s+(?:${word})\\b`, 'i').test(text))
      .map(([race]) => race);
    const anyMates =
      yourRaces.length === 0 ||
      state.board.some((m) => {
        if (m.entityId === candidate.entityId) return false;
        const races = racesOf(m, cards);
        return races.includes(RACE_ALL) || yourRaces.some((r) => races.includes(r));
      });
    if (anyMates) battle = w.battleEffect;
  }

  // Племя, названное словами в тексте, — та же связь с композицией, что
  // у тринкетов. Без неё Kangor's Apprentice (без племени, «…your first
  // 2 Mechs that died») на борде из мехов была слабейшей по голым статам,
  // и советник предлагал продать её ради чужого племени (part9, ход 19).
  const textMates = boardMatesOfTribes(
    textTribesOf(candidate.cardId, cards, rules),
    state.board.filter((m) => m.entityId !== candidate.entityId),
    cards,
  );
  const textTribe = textMates * w.perTextTribeMate;

  // Механика — та же связь, что у племён, и в обе стороны: кандидат её
  // называет, а свои несут (Titus Rivendare на борде хрипов, part15), либо
  // кандидат её несёт, а свои называют (нага со Spellcraft на борде,
  // живущем заклинаниями, part18).
  const textMechMates = boardMatesOfMechanics(
    textMechanicsOf(candidate.cardId, cards, rules),
    candidate,
    state.board.filter((m) => m.entityId !== candidate.entityId),
    cards,
    rules,
  );
  const textMech = textMechMates * w.perTextMechMate;

  // Связь по ИМЕНИ карты — прямее племени: Automaton Portrait называет
  // Ancestral Automaton, а племени у портрета нет вовсе.
  const namedMates = namedCardMates(candidate, state.board, cards);
  const namedCard = namedMates * w.perNamedCardMate;

  // Магнит заклинаний ценен ровно теми заклинаниями, что у нас ЕСТЬ: Fleeing
  // Fugitive получает свои +1 здоровья с каждого применённого к нему,
  // Lava Lurker оставляет навсегда временное усиление. Заклинания руки —
  // читаемый факт состояния, и выгода считается тем же `spellMagnetGain`,
  // что и у выбора цели: одна формула на покупку и на применение
  // (part21, ход 5 — три заклинания в руке при беглеце в витрине).
  //
  // Отдельного веса у слагаемого нет: выгода измерена в СТАТАХ, а у статов
  // цена уже есть. Будущие заклинания (свой чародей на борде выдаёт по одному
  // за ход) не считаются — это ставка, а не факт; связь с чародеем и так
  // даёт `perTextMechMate`.
  const magnetStats = state.handSpells.reduce((sum, spell) => {
    const effect = spellEffect(spell.cardId, spell.scriptData, cards, rules);
    if (effect === null || effect.untargeted || effect.destroysFriendly) return sum;
    if (effect.stats <= 0 && !effect.divineShield && !effect.grantsTaunt) return sum;
    return sum + (spellMagnetGain(candidate, effect, spell.cardId, cards, rules)?.gain ?? 0);
  }, 0);
  const spellMagnet = magnetStats * w.perStatPoint;

  // Удвоитель механики на борде множит эффект кандидата, а не добавляет
  // «ещё одного своего»: при Бранне «Battlecry: Get a Deepwater Clan»
  // приносит ДВЕ карты, а `perTextMechMate` начислял за него полторы очка,
  // как за рядовую связь (part22, ход 23 — кличевой мурлок стоял вторым
  // после карты с эффектом конца хода, удваивать который некому).
  //
  // Очки начисляются только там, где известно ЧТО удваивается: у триггера,
  // ПРИНОСЯЩЕГО карту, есть курс — тот же `heroPowerSpellValue`, которым
  // считается прокрутка генератора и заклинание от силы героя. Удвоение
  // эффекта без добычи (аура, статы) остаётся обычной связью: множитель
  // там реален, а цены у него нет, и выдумывать её мы не будем.
  const carried = new Set(info?.mechanics ?? []);
  const doubles = doubledMechanicsOnBoard(state.board, candidate, cards, rules).filter((mech) =>
    carried.has(mech),
  );
  const brings =
    text !== '' && rules.triggerGetWords.some((word) => new RegExp(word, 'i').test(text));
  const doubler = doubles.length > 0 && brings ? rules.heroPowerSpellValue : 0;

  // Сила героя — такой же читаемый текст, как текст миньона борда, и связи
  // из неё читаются теми же таблицами. Прежде ценность покупки смотрела
  // только на борд и на саму карту, и герой не влиял ни на что (part22,
  // ход 1: Грибомант Флургл, «After you sell 5 minions, get a random
  // Murloc», — а советник предложил дракона вместо мурлока, чья ценность
  // реализуется ровно продажей).
  //
  // Два слагаемых, оба однократные — это факт о КАНДИДАТЕ, а не о числе
  // своих на борде:
  //  - племя, названное силой: вес как у племени из текста карты
  //    (`perTextTribeMate`) — упоминание слабее принадлежности;
  //  - продажа: сила платит за то же действие, которым карта отдаёт своё
  //    обещание, поэтому вес тот же, что у собственной экономики карты.
  const heroPowerText = state.hero?.heroPowerCardId == null
    ? ''
    : (cards.info(state.hero.heroPowerCardId)?.text ?? '');
  let heroPower = 0;
  if (heroPowerText !== '') {
    const myRaces = racesOf(candidate, cards);
    const heroTribes = Object.entries(rules.tribeTextWords)
      .filter(([, word]) => new RegExp(`\\b(?:${word})\\b`, 'i').test(heroPowerText))
      .map(([race]) => race);
    if (heroTribes.some((r) => myRaces.includes(r) || myRaces.includes(RACE_ALL))) {
      heroPower += w.perTextTribeMate;
    }
    const heroSells = rules.heroPowerSellWords.some((word) =>
      new RegExp(word, 'i').test(heroPowerText),
    );
    const cardSells =
      text !== '' && rules.sellValueWords.some((word) => new RegExp(word, 'i').test(text));
    if (heroSells && cardSells) heroPower += w.economy;
  }

  return {
    techLevel: tech,
    stats,
    tribe,
    keywords,
    copies,
    golden,
    economy,
    battle,
    textTribe,
    textMech,
    namedCard,
    spellMagnet,
    doubler,
    heroPower,
    total:
      tech +
      stats +
      tribe +
      keywords +
      copies +
      golden +
      economy +
      battle +
      textTribe +
      textMech +
      namedCard +
      spellMagnet +
      doubler +
      heroPower,
    tribeMates: mates,
    textTribeMates: textMates,
    textMechMates,
    namedCardMates: namedMates,
    copiesOwned: owned,
  };
}

/**
 * Ключевые слова, которые второй раз не дарятся: они у миньона либо есть,
 * либо нет, и магнитить их носителю, у которого они уже есть, — потеря.
 * Слева — механика в снапшоте, справа — живой признак миньона из лога.
 */
const BINARY_KEYWORD_FLAGS: readonly (readonly [string, (m: Minion) => boolean])[] = [
  ['REBORN', (m) => m.reborn],
  ['DIVINE_SHIELD', (m) => m.divineShield],
  ['TAUNT', (m) => m.taunt],
  ['WINDFURY', (m) => m.windfury],
  ['POISONOUS', (m) => m.poisonous],
  ['VENOMOUS', (m) => m.venomous],
  ['STEALTH', (m) => m.stealth],
];

/**
 * Виден ли яд у соперников — по накопленным бордам поля.
 *
 * Ядовитый миньон (poisonous/venomous) убивает любым касанием в обе
 * стороны: и когда атакует сам, и когда об него разбиваются. Против него
 * статы, сложенные магнитами в одно тело, обнуляются одним касанием —
 * на это указал игрок после part13. Гадать тут не нужно: борды соперников
 * мы уже видели, и яд в них — читаемый факт, а не оценка.
 */
export function poisonAmongSeen(state: GameState): boolean {
  return Object.values(state.lastSeenBoards).some((board) =>
    board.some((m) => m.poisonous || m.venomous),
  );
}

/**
 * Лучший носитель для магнитного миньона.
 *
 * Магнитный миньон можно не ставить в отдельный слот, а присоединить
 * к своему миньону: статы и способности перейдут носителю.
 *
 * Кому магнититься — читается с карты магнита и из виденного, не
 * выдумывается:
 *
 *  - **племена носителя** — поле `races` самого магнита: обычный магнит
 *    несёт `MECH`, а «Рука-протез» — `MECH, UNDEAD` («Can Magnetize to
 *    Mechs or Undead», part13);
 *  - **дар магнита** — его механики: если магнит дарит перерождение,
 *    носитель, у которого перерождение уже есть, получит его впустую.
 *    На part13 (ход 19) «Рука-протез» советовалась на Rescue Bot, уже
 *    перерождённого прошлой такой же рукой, — на что игрок и указал;
 *  - **яд у соперников** (`poisonThreat`) — при виденном яде носитель
 *    со щитом предпочтительнее просто крупного: щит поглощает ядовитое
 *    касание, а голые статы об него обнуляются. Если сам магнит дарит
 *    щит, угроза для носителя снята и размер снова главный.
 *
 * Порядок предпочтений: пригодные по племени → кому дар не пропадёт →
 * при яде со щитом → самый крупный. Каждый следующий фильтр отступает,
 * если оставляет пусто: статы складываются всегда, и совсем без носителя
 * магнит остаётся телом.
 */
export function magnetizeTarget(
  magnet: Minion,
  board: readonly Minion[],
  cards: CardIndex,
  poisonThreat = false,
): Minion | null {
  const magnetInfo = cards.info(magnet.cardId);
  const carrierRaces =
    magnetInfo !== null && magnetInfo.races.length > 0
      ? magnetInfo.races.filter((r) => r !== RACE_ALL)
      : ['MECH'];

  const eligible = board.filter((m) => {
    const races = racesOf(m, cards);
    return races.includes(RACE_ALL) || carrierRaces.some((r) => races.includes(r));
  });
  if (eligible.length === 0) return null;

  const largest = (list: readonly Minion[]): Minion =>
    list.reduce((a, b) =>
      (b.attack ?? 0) + (b.health ?? 0) > (a.attack ?? 0) + (a.health ?? 0) ? b : a,
    );

  const grants = BINARY_KEYWORD_FLAGS.filter(([mech]) =>
    magnetInfo?.mechanics.includes(mech) ?? false,
  );
  let pool = eligible;
  if (grants.length > 0) {
    const keepsGift = pool.filter((m) => grants.some(([, has]) => !has(m)));
    if (keepsGift.length > 0) pool = keepsGift;
  }

  const magnetGivesShield = magnetInfo?.mechanics.includes('DIVINE_SHIELD') ?? false;
  if (poisonThreat && !magnetGivesShield) {
    const shielded = pool.filter((m) => m.divineShield);
    if (shielded.length > 0) pool = shielded;
  }

  return largest(pool);
}

/**
 * Работает ли миньон ИЗ РУКИ — по собственному тексту.
 *
 * Признак читаемый и в пуле массовый ровно настолько, насколько нужен:
 * карт с «in your hand» четырнадцать, и ВСЕ мурлоки. Трое из них работают
 * из руки сами (Flighty Scout, Bream Counter, Timewarped Astrogill),
 * остальные одиннадцать рукой питаются — тех этот признак не ловит,
 * и правильно: они как раз хотят на борд.
 */
export function isHandWorker(
  minion: Minion,
  cards: CardIndex,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): boolean {
  const text = cards.info(minion.cardId)?.text ?? '';
  return text !== '' && rules.handWorkerWords.some((w) => new RegExp(w, 'i').test(text));
}

/** Магнитный ли миньон — механика MODULAR в справочнике. */
function isMagnetic(minion: Minion, cards: CardIndex): boolean {
  return cards.info(minion.cardId)?.magnetic === true;
}

/**
 * Сколько стоит купить именно этого миньона.
 *
 * Цена покупки — правило игры (3 золота, тега цены у миньонов витрины нет),
 * но герои, дары и тринкеты её меняют, и скидка видна на самом миньоне:
 * тег `BACON_REDUCE_BUY_COST` — сколько золота скинуто; парный
 * `BACON_SHOW_OVERRIDEN_MINION_COST=1` велит клиенту рисовать новую цену.
 * Фактура: part3 — 9999 на ранних витринах (миньоны бесплатны, кламп
 * в ноль), part4 — скидка 2 на части витрины (цена 1). По окончании
 * эффекта тег сбрасывается в 0.
 */
export function buyCostOf(minion: Minion, rules: TavernRules = DEFAULT_TAVERN_RULES): number {
  const reduce = minion.tags['BACON_REDUCE_BUY_COST'] ?? 0;
  return Math.max(0, rules.minionCost - reduce);
}

/**
 * Цена обновления витрины — живая, из кнопки; таблица только запасной путь.
 *
 * Экономику меняют не только тринкеты: «Leaf Through the Pages» («Gain 2
 * free Refreshes», part17 ходы 19 и 21; part13 ход 23) и напарник Magnus
 * Manastorm («Two Refreshes each turn are free», part12 ходы 15–27) роняют
 * `COST` кнопки в ноль на целый ход. Советник считал по таблице и в эти
 * ходы честно не знал, что обновление бесплатно, — то же самое было бы
 * с любым экономическим тринкетом. Правило прежнее: читать факт, а не
 * моделировать эффект.
 */
export function rerollCostOf(state: GameState, rules: TavernRules = DEFAULT_TAVERN_RULES): number {
  return state.rerollCost ?? rules.rerollCost;
}

/**
 * Есть ли смысл в ПЛАТНОМ обновлении витрины прямо сейчас.
 *
 * Смысл появляется, когда найденное будет на что купить: обновление ради
 * взгляда — это потеря золота, а заморозить найденное значит отдать даром
 * бесплатное обновление следующего хода. Случай part18 (ход 7, скриншот
 * игрока): план советовал «подняться за 5 и обновить на оставшийся 1»,
 * хотя на витрину нового тира этого золота уже не хватало ни на что.
 * Игрок указал прямо: в ранней игре обновлять нежелательно.
 *
 * С `lateRerollTier` правило снимается: в лейте обновление — это поиск
 * конкретной карты под заморозку, и «не хватит купить сейчас» ему не довод
 * (part11, тот же игрок: «ценны рероллы позже»). Бесплатное обновление
 * не тратит ничего и не спрашивается вовсе.
 */
export function paidRerollIsUseful(
  state: GameState,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): boolean {
  const cost = rerollCostOf(state, rules);
  if (cost === 0) return true;
  if (state.techLevel >= rules.lateRerollTier) return true;
  return state.gold - cost >= rules.minionCost;
}

/**
 * Племена, доказанные витриной, — состав партии, накопленный по факту.
 *
 * Прямого тега состава в логе нет. Витрина предлагает только пул партии,
 * поэтому ОДНОПЛЕМЕННЫЙ миньон витрины доказывает своё племя. Двуплеменные
 * доказательством не являются: «Рука-протез» (MECH/UNDEAD) была в пуле
 * part11 из-за нежити — мехов в той партии не было. Амальгамы (ALL) тоже
 * мимо. Тег `CARDRACE` не годится вдвойне: он строковый и показывает одно
 * племя даже у двуплеменной карты (part11: MECHANICAL на руке-протезе).
 *
 * Множество растёт по ходу партии и полноты не обещает: редкое племя может
 * долго не выпадать. Поэтому потребители сверяются с ним только когда
 * накоплено хотя бы `rules.lobbyRacesKnownAfter` племён.
 */
export function lobbyRaces(state: GameState, cards: CardIndex): ReadonlySet<string> {
  const races = new Set<string>();
  for (const cardId of state.seenShopCardIds) {
    const own = (cards.info(cardId)?.races ?? []).filter((r) => r !== RACE_ALL);
    if (own.length === 1 && own[0] !== undefined) races.add(own[0]);
  }
  return races;
}

/**
 * Энчант карты, добытой заклинанием или наградой, — сам по себе означает
 * лишь «розыгрыш бесплатен» (текст энчанта — «Costs (0)»).
 *
 * Урок part16: правило part11 читало его как «умрёт, если разыграть в этот
 * ход» — но смертность несёт ТЕКСТ ИСТОЧНИКА, а не энчант. «Восстание
 * из гробницы» (BG34_888, part11) пишет «It dies if you play it this turn»;
 * а карты от «Friendly Bounty», «Chef's Choice» и награды за тройку носят
 * тот же энчант и не умирают вовсе — прежнее правило прятало розыгрыш всей
 * руки (part16, ход 21: три миньона в руке, место на борде, совет «НИЧЕГО»,
 * на что игрок и указал). Источник читается тегом CREATOR_DBID.
 */
const DOOMED_ENCHANTMENT = 'TB_BaconShopBadsongE';
// Пробелы — \s+: тексты снапшота переносят строки посреди предложения.
const DOOMED_CREATOR_WORDS = /dies\s+if\s+you\s+play\s+it\s+this\s+turn/i;

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
  // Витрина из мусора — довод подняться, а не покупать: лучший кандидат
  // ниже порога «покупать нечего» (тот же порог, что у реролла), и слабая
  // покупка выигрывала у подъёма только тем, что подъём по графику получал
  // ноль очков. Правило из базы знаний JeefHS («если в таверне только
  // мусор — повышайте уровень», docs/jeefhs.md), внесено по указанию игрока.
  const trashThreshold = rules.value.perTechLevel * state.techLevel + rules.rerollMarginOverTier;
  const bestBuy = buys.length > 0 ? Math.max(...buys.map((b) => b.score)) : null;
  const shopIsTrash = bestBuy !== null && bestBuy < trashThreshold;
  if (behind > 0 && bestBuy !== null) {
    const triple = buys
      .filter((b) => b.minion !== null && copiesOwned(b.minion, state) >= 2)
      .reduce((best: number | null, b) => (best === null || b.score > best ? b.score : best), null);
    const affordBoth = state.gold >= cost + rules.minionCost;

    score =
      triple !== null && !affordBoth
        ? // Золота на одно: тройку упускать нельзя, подъём сразу за ней.
          triple - 0.5
        : bestBuy + behind * rules.levellingUrgencyPerTier;
  } else if (behind === 0 && bestBuy !== null && shopIsTrash && rerollCostOf(state, rules) > 0) {
    // Довод «витрина из мусора» держится на том, что обновление стоит золота.
    // Когда оно бесплатно (заклинание «Gain 2 free Refreshes», напарник
    // Magnus Manastorm, тринкеты), мусор — довод обновиться, а не подняться:
    // подъём того же мусора не отменяет.
    score = bestBuy + rules.levellingUrgencyPerTier;
  }

  // Судьба остатка, которого не хватит на покупку, зависит от стадии.
  // Поздно (от lateRerollTier) обновление за 1 — полноценная трата: идёт
  // поиск конкретных карт. Рано реролл на сдачу — пустая трата: найденное
  // пришлось бы морозить, теряя бесплатное обновление, и честнее назвать
  // остаток ценой подъёма (указано игроком, part10 ход 7 и part11).
  const leftover = state.gold - cost;
  const late = (state.tavernUpgradeTarget ?? state.techLevel + 1) >= rules.lateRerollTier;
  const leftoverTail =
    leftover >= rerollCostOf(state, rules) && leftover < rules.minionCost
      ? late
        ? `; остаток ${String(leftover)} — на обновление витрины нового тира`
        : `; остаток ${String(leftover)} сгорит — это цена подъёма`
      : '';

  return {
    action: 'levelUp',
    minion: null,
    score,
    cost,
    requiresSlot: false,
    sellFirst: null,
    reason:
      (behind > 0
        ? `таверна ${String(state.techLevel)} при ожидаемых ${String(wanted)} к ${String(tavernTurnOf(state.turn))}-му ходу таверны` +
          `, подъём до ${String(target)} стоит ${String(cost)} из ${String(state.gold)}${widerShop}`
        : shopIsTrash
          ? `таверна ${String(state.techLevel)} по графику, но витрина без покупок ` +
            `(лучшее ${(bestBuy ?? 0).toFixed(1)} при пороге ${trashThreshold.toFixed(0)}) — ` +
            `подъём до ${String(target)} за ${String(cost)} вместо слабой покупки${widerShop}`
          : `таверна ${String(state.techLevel)} и так по графику, подъём до ${String(target)} за ${String(cost)} — на опережение${widerShop}`) +
      leftoverTail,
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

/**
 * Аура на ЧУЖИХ: ценность миньона — то, что он делает с остальным бордом,
 * а не собственное тело. Признак — механика `AURA` в снапшоте, кроме аур
 * О СЕБЕ («Has +{0}/+{1} for each…»), у которых эффект и есть статы.
 *
 * В пуле 17 карт с AURA, и разделяются они этим признаком начисто: восемь
 * пумпят себя (Eternal Knight, Abyssal Bruiser, Maritime Extortionist…),
 * девять усиливают чужое (Brann «Your Battlecries trigger twice», Titus
 * «Your Deathrattles trigger an extra time», Drakkari Enchanter, Timewarped
 * Swirler…).
 */
function isAuraOverOthers(m: Minion, cards: CardIndex, rules: TavernRules): boolean {
  const info = cards.info(m.cardId);
  if (!(info?.mechanics.includes('AURA') ?? false)) return false;
  const text = info?.text ?? '';
  return !rules.selfAuraWords.some((w) => new RegExp(w, 'i').test(text));
}

/**
 * Слабейший свой — кандидат на продажу, когда борд полон.
 *
 * Ауры на чужих в жертвы не идут, пока есть хоть одно обычное тело (part19,
 * ход 27). Наша шкала меряет ТЕЛА: тир, статы, ключевые слова. У Бранна
 * Бронзоборода тело 27/29 при борде в сотни статов — по шкале он слабейший
 * и первым уходил в продажу, хотя ценность его в том, что он удваивает
 * боевые кличи ВСЕХ будущих покупок (в витрине того хода стоял Mind Muck
 * с кличем-поглощением). Продавать по числу, про которое сами знаем, что
 * оно не про эту карту, — это не осторожность, а ошибка.
 *
 * Если весь борд из таких аур, выбор честно возвращается к слабейшему
 * из них: место под покупку взять всё равно откуда-то надо. Тот же приём,
 * что у цели провокации с миньонами-движками (part15).
 */
export function weakestOwn(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): { minion: Minion; value: number } | null {
  if (state.board.length === 0) return null;
  const bodies = state.board.filter((m) => !isAuraOverOthers(m, deps.cards, rules));
  const pool = bodies.length > 0 ? bodies : state.board;
  return pool
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
    // Цена у каждого миньона своя: скидки героев и даров видны тегом
    // на самом миньоне, и «не по карману» решается по ней, а не по трём.
    .filter((m) => buyCostOf(m, rules) <= state.gold)
    .flatMap((minion) => {
      const cost = buyCostOf(minion, rules);
      let value = minionValue(minion, state, deps, rules);
      const name = deps.cards.info(minion.cardId)?.name ?? minion.cardId;

      // Магнитному миньону носитель называется всегда, а не только на полном
      // борде: игрок решает «телом или примагнитить», и совет без носителя
      // перекладывал половину решения на него (part13, ход 15). На полном
      // борде носитель ещё и освобождает от продажи: слот магниту не нужен.
      const host = isMagnetic(minion, deps.cards)
        ? magnetizeTarget(minion, state.board, deps.cards, poisonAmongSeen(state))
        : null;

      // Сколько копий кандидата стоит на борде: тройка сливает их в золотого,
      // и место освобождается само.
      const copiesOnBoard = minion.golden
        ? 0
        : state.board.filter((b) => b.cardId === minion.cardId && !b.golden).length;

      const notes: string[] = [];
      let sellFirst: Minion | null = null;
      let requiresSlot = false;

      if (full && host === null) {
        if (value.copiesOwned >= 2 && copiesOnBoard >= 1) {
          // Тройка собирается, и хотя бы одна копия на борде: слияние заберёт
          // её и освободит слот — продавать никого не нужно (part10, ход 13:
          // советник предлагал продать Тавматурга ради третьего дракончика).
          notes.push('соберёт тройку — место освободится само');
        } else if (value.copiesOwned >= 1) {
          // Вторая копия покупается В РУКУ, под будущую тройку: слот ей
          // не нужен, пока её не разыгрываешь.
          notes.push('борд полон — в руку, под тройку');
        } else if (victim !== null) {
          // Продажа оправдана только явным превосходством, и считать его надо
          // против борда БЕЗ жертвы: иначе кандидат получает бонусы от
          // миньона, которого сам же и продаёт, — на part10 дракончик
          // предлагал продать такого же дракончика ради «второй копии».
          const without = state.board.filter((x) => x.entityId !== victim.minion.entityId);
          const replacing = minionValue(minion, { ...state, board: without }, deps, rules);
          if (replacing.total <= victim.value + rules.sellMargin) return [];
          value = replacing;
          sellFirst = victim.minion;
          requiresSlot = true;
          const victimName = deps.cards.info(victim.minion.cardId)?.name ?? victim.minion.cardId;
          notes.push(`борд полон, продать ${victimName} (${victim.value.toFixed(1)})`);
        } else {
          notes.push('борд полон');
        }
      }

      // Пометка про копии не дублирует ветку тройки на полном борде выше.
      if (value.copiesOwned >= 2 && !notes.some((n) => n.includes('тройку'))) {
        notes.unshift('собирает тройку');
      } else if (value.copiesOwned === 1 && !notes.some((n) => n.includes('тройку'))) {
        notes.unshift('вторая копия');
      }
      if (value.tribeMates > 0) notes.push(`своих по племени ${String(value.tribeMates)}`);
      if (value.textTribeMates > 0) {
        notes.push(`племя из текста: своих ${String(value.textTribeMates)}`);
      }
      if (value.textMechMates > 0) {
        notes.push(`механика из текста: своих ${String(value.textMechMates)}`);
      }
      if (value.namedCardMates > 0) {
        notes.push(`связана по имени: своих ${String(value.namedCardMates)}`);
      }
      if (value.doubler > 0) notes.push('свой удвоитель на борде — триггер принесёт вдвое');
      if (value.economy > 0) notes.push('вернёт часть цены при продаже');
      if (minion.golden) notes.push('золотой');
      if (host !== null) {
        const hostName = deps.cards.info(host.cardId)?.name ?? host.cardId;
        const shieldHint =
          poisonAmongSeen(state) && host.divineShield ? ' (у соперников яд — носитель со щитом)' : '';
        notes.push(
          full
            ? `борд полон, но магнитится — примагнитить к ${hostName}${shieldHint}`
            : `магнитный — носитель ${hostName}${shieldHint}`,
        );
      }

      // Скидка — не деталь: покупка за 0–1 меняет весь план хода, и совет
      // обязан говорить о ней вслух, а не прятать в поле cost.
      if (cost < rules.minionCost) {
        notes.push(`скидка — за ${String(cost)} вместо ${String(rules.minionCost)}`);
      }

      // Тир берётся с тем же запасным вариантом, что и в оценке: у миньона
      // витрины тега `TECH_LEVEL` может ещё не быть, и подпись «тир ?» рядом
      // с посчитанной по тиру ценностью выглядела бы противоречием.
      const tier = minion.techLevel ?? deps.cards.info(minion.cardId)?.techLevel ?? null;

      return [
        {
          action: 'buy' as const,
          minion,
          score: value.total,
          cost,
          requiresSlot,
          sellFirst,
          magnetizeTo: host,
          reason:
            `${name} ${String(minion.attack ?? '?')}/${String(minion.health ?? '?')} ` +
            `тир ${tier === null ? '?' : String(tier)}, ценность ${value.total.toFixed(1)}` +
            (notes.length > 0 ? ` — ${notes.join(', ')}` : ''),
        },
      ];
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
    // Заблокированную карту разыграть нельзя, и советовать её — тихо неверно.
    // Пример из part8: Polarizing Beatboxer 5/10, выданный тринкетом
    // с замком на два хода, — тег LITERALLY_UNPLAYABLE, тикает и снимается.
    if ((minion.tags['LITERALLY_UNPLAYABLE'] ?? 0) > 0) return [];

    // Карта-смертник: источник («Восстание из гробницы», part11) пишет
    // «It dies if you play it this turn», и розыгрыш в ход получения
    // оправдан только предсмертным хрипом или перерождением. Смертность —
    // по ТЕКСТУ создателя (тег CREATOR_DBID), а не по энчанту Badsong:
    // энчант значит лишь «бесплатно» и висит на любых добытых картах —
    // от наград за тройку до пиратской экономики (part16, ход 21).
    // NUM_TURNS_IN_HAND=1 отличает ход получения.
    const creatorDbf = minion.tags['CREATOR_DBID'];
    const creator = creatorDbf === undefined ? null : deps.cards.infoByDbfId(creatorDbf);
    const doomed =
      minion.enchantments.some((e) => e.cardId === DOOMED_ENCHANTMENT) &&
      (minion.tags['NUM_TURNS_IN_HAND'] ?? 1) <= 1 &&
      DOOMED_CREATOR_WORDS.test(creator?.text ?? '');
    const doomedWorthIt =
      minion.reborn ||
      (deps.cards.info(minion.cardId)?.mechanics.some(
        (m) => m === 'DEATHRATTLE' || m === 'REBORN',
      ) ??
        false);
    if (doomed && !doomedWorthIt) return [];

    // Карта, РАБОТАЮЩАЯ ИЗ РУКИ, розыгрышем себя же и отменяет. Признак —
    // её собственный текст (`handWorkerWords`), и пород две:
    //
    //  - «Start of Combat: If this minion is in your hand, summon a copy
    //    of it» (Flighty Scout). Тел в бою поровну: копия приходит и без
    //    розыгрыша. Разница только в слоте — разыгранная карта занимает
    //    место на борде НАВСЕГДА, а лежащая в руке воюет бесплатно. Это
    //    арифметика из текста карты, а не мнение.
    //  - «While this is in your hand, after you play a Murloc, gain
    //    +{0}/+{1}» (Bream Counter). Розыгрыш ОСТАНАВЛИВАЕТ рост, и цена
    //    остановки ближайшему бою невидима — ровно как у экономики.
    //    На part22 план каждый ход предлагал выставить счетовода; игрок
    //    держал его в руке, и тот дорос с 208/206 до 670/668.
    //
    // Замер (`npm run spike:hand`) правило НЕ доказывает и на это не
    // претендует: он объявлен негодным по собственному предрегистрированному
    // критерию — контроль своего порога не взял (0.648 при 1.170), потому
    // что на 59 точках из 68 лишнее тело ближайший бой не меняет вовсе.
    // Что он показал — согласие: у «играет из руки» разность розыгрыша
    // −0.05 п.п., то есть ровно ноль, при +0.65 у обычной карты. Числа
    // и оговорки — в docs/tavern.md.
    //
    // Купить такую карту по-прежнему советуется: из руки она и работает.
    if (isHandWorker(minion, deps.cards, rules)) return [];

    let value = minionValue(minion, state, deps, rules);

    // Магнитный миньон при полном борде идёт не через продажу, а через
    // примагничивание: слот ему не нужен (part9, ход 13: советник предлагал
    // продать Molten Rock ради Accord-o-Tron). Носитель называется и на
    // неполном борде — игрок решает «телом или примагнитить», и совет без
    // носителя перекладывал половину решения на него (part13, ход 15).
    const host = isMagnetic(minion, deps.cards)
      ? magnetizeTarget(minion, state.board, deps.cards, poisonAmongSeen(state))
      : null;

    // На полном борде розыгрыш идёт через продажу. Ценность кандидата
    // считается против борда БЕЗ жертвы — иначе он получает бонусы от
    // миньона, которого сам вытесняет: на part10 дракончик из руки
    // предлагал «продать» такого же дракончика с борда, потому что тот
    // числился его «второй копией». И превосходство обязано быть явным,
    // с тем же порогом, что у правила продажи: менять почти равного
    // на почти равного — потерянный ход.
    if (full && host === null) {
      if (victim === null) return [];
      const without = state.board.filter((x) => x.entityId !== victim.minion.entityId);
      const replacing = minionValue(minion, { ...state, board: without }, deps, rules);
      if (replacing.total <= victim.value + rules.sellMargin) return [];
      value = replacing;
    }

    const name = deps.cards.info(minion.cardId)?.name ?? minion.cardId;
    const notes: string[] = [];
    if (doomed) notes.push('умрёт при розыгрыше в этот ход — но хрип/перерождение сработают');
    if (value.copiesOwned >= 2) notes.push('собирает тройку');
    else if (value.copiesOwned === 1) notes.push('вторая копия');
    if (minion.golden) notes.push('золотой');
    if (value.tribeMates > 0) notes.push(`своих по племени ${String(value.tribeMates)}`);
    if (value.textTribeMates > 0) {
      notes.push(`племя из текста: своих ${String(value.textTribeMates)}`);
    }
    if (value.namedCardMates > 0) {
      notes.push(`связана по имени: своих ${String(value.namedCardMates)}`);
    }
    if (host !== null) {
      const hostName = deps.cards.info(host.cardId)?.name ?? host.cardId;
      const shieldHint =
        poisonAmongSeen(state) && host.divineShield ? ' (у соперников яд — носитель со щитом)' : '';
      notes.push(
        full
          ? `борд полон, но магнитится — к ${hostName}${shieldHint}`
          : `магнитный — носитель ${hostName}${shieldHint}`,
      );
    } else if (full && victim !== null) {
      const victimName = deps.cards.info(victim.minion.cardId)?.name ?? victim.minion.cardId;
      notes.push(`борд полон, продать ${victimName} (${victim.value.toFixed(1)})`);
    }

    return [
      {
        action: 'play' as const,
        minion,
        score: value.total,
        cost: 0,
        requiresSlot: full && host === null,
        sellFirst: full && host === null ? (victim?.minion ?? null) : null,
        magnetizeTo: host,
        reason:
          `${name} ${String(minion.attack ?? '?')}/${String(minion.health ?? '?')} из руки, ` +
          `ценность ${value.total.toFixed(1)}` +
          (notes.length > 0 ? ` — ${notes.join(', ')}` : ''),
      },
    ];
  });
}

/**
 * Правило прокрутки: купить батлкрай-генератора карт, разыграть, продать.
 *
 * Случай part16 (ход 3 игрока): Oozeling Gladiator 2/2 («Battlecry: Get two
 * Slimy Shields…») стоил 3, продажа вернула бы 1 — два заклинания за чистых
 * два золота, и на остаток всё ещё покупалась золотая пиратка. Советник же
 * предлагал сразу пиратку, и два золота сгорали — на что игрок и указал.
 *
 * Порядок в цепочке важен: прокрутка идёт ПЕРВОЙ, пока золота хватает
 * и на неё, и на лучшую покупку, — поэтому при выполнимости обоих её очки
 * ставятся выше лучшей покупки, и reason называет, что купить следом.
 * Границы честные: генератор, который сам является лучшей покупкой,
 * не прокручивается (его хочется оставить телом), копия под тройку — тоже
 * (продажа ломает тройку), на полном борде разыгрывать некуда.
 */
export function spinRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
  buys: readonly Recommendation[] = [],
): Recommendation | null {
  if (state.board.length >= rules.boardSize) return null;

  const bestBuy = buys.reduce(
    (a: Recommendation | null, b) => (a === null || b.score > a.score ? b : a),
    null,
  );
  const numbers: Readonly<Record<string, number>> = { two: 2, three: 3, four: 4 };

  let best: { minion: Minion; count: number; net: number; score: number } | null = null;
  for (const minion of state.shop) {
    const cost = buyCostOf(minion, rules);
    if (cost > state.gold) continue;
    // Лучшую покупку не прокручивают — её хочется оставить телом.
    if (bestBuy?.minion?.entityId === minion.entityId) continue;
    // Копию не прокручивают: продажа ломает будущую тройку.
    if (copiesOwned(minion, state) > 0) continue;

    const text = deps.cards.info(minion.cardId)?.text ?? '';
    if (text === '') continue;
    if (!rules.battlecryGetWords.some((w) => new RegExp(w, 'i').test(text))) continue;

    const countWord = /\b(two|three|four)\b/i.exec(text);
    const count = countWord?.[1] === undefined ? 1 : (numbers[countWord[1].toLowerCase()] ?? 1);
    const net = cost - rules.sellGold;
    const base = count * rules.heroPowerSpellValue - net * rules.goldPointValue;
    if (base <= 0) continue;

    // Пока выполнимы и прокрутка, и лучшая покупка, прокрутка идёт первой:
    // начатая с покупки цепочка умирает — золота на генератора не остаётся.
    const affordBoth =
      bestBuy?.minion != null && state.gold - net >= buyCostOf(bestBuy.minion, rules);
    const score = affordBoth && bestBuy !== null ? bestBuy.score + 0.5 : base;
    if (best === null || score > best.score) best = { minion, count, net, score };
  }
  if (best === null) return null;

  const name = deps.cards.info(best.minion.cardId)?.name ?? best.minion.cardId;
  const followUp =
    bestBuy?.minion != null && state.gold - best.net >= buyCostOf(bestBuy.minion, rules)
      ? `; потом ${deps.cards.info(bestBuy.minion.cardId)?.name ?? bestBuy.minion.cardId}`
      : '';

  return {
    action: 'spin',
    minion: best.minion,
    score: best.score,
    cost: best.net,
    requiresSlot: false,
    sellFirst: null,
    reason:
      `купить ${name}, разыграть (клич даст ${String(best.count)} карт.) и продать — ` +
      `чистая цена ${String(best.net)}${followUp}`,
  };
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
  if (state.shop.length === 0) return null;

  const best = state.shop
    .map((m) => ({ minion: m, value: minionValue(m, state, deps, rules).total }))
    .reduce((a, b) => (b.value > a.value ? b : a));
  // По карману ли лучший — по его собственной цене: скидка на него видна
  // тегом на миньоне, и трёх золотых может не понадобиться.
  if (buyCostOf(best.minion, rules) > state.gold) return null;

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
 * Правило продажи карты, чья ценность РЕАЛИЗУЕТСЯ ПРОДАЖЕЙ.
 *
 * «When you sell this, get a random Tier 1 minion» (River Skipper),
 * «…get a Water Droplet» (Sellemental): обещанное записано в тексте, но
 * получить его можно только продав. Прежний `sellRule` продаёт лишь ради
 * МЕСТА на полном борде, и такие карты держались телом до конца партии.
 *
 * Условие продажи — золото должно открыть ЕЩЁ ОДНУ покупку: пять золотых
 * покупают одного миньона, шесть — двоих. Без этого продажа даёт монету,
 * которой некуда деться, и теряет тело. Случай part18 (ход 5): скипер 1/1
 * при пяти золотых — игрок продал его и купил два тела вместо одного тела
 * и заклинания.
 *
 * Удерживаемая ценность считается БЕЗ слагаемого экономики: оно и есть
 * то, что придёт при продаже, и держать карту ради него — не получить его
 * никогда.
 */
export function sellForGoldRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  if (state.board.length === 0 || state.shop.length === 0) return null;

  // Продажа открывает покупку только если меняет ЧИСЛО доступных покупок.
  const affordable = (gold: number): number => Math.floor(gold / rules.minionCost);
  if (affordable(state.gold + rules.sellGold) <= affordable(state.gold)) return null;

  const sellable = state.board.filter((m) => {
    const text = deps.cards.info(m.cardId)?.text ?? '';
    if (text === '' || !rules.sellValueWords.some((w) => new RegExp(w, 'i').test(text))) {
      return false;
    }
    // Копия, из которой собирается тройка, не продаётся: тройка стоит
    // больше любого обещания текста, и вторая копия — ставка на неё.
    return copiesOwned(m, state) === 0;
  });
  if (sellable.length === 0) return null;

  // Что купится на открывшееся золото: лучшее в витрине, чего мы ещё не
  // держим на борде. Цена читается с миньона — скидки видны тегом.
  const buys = state.shop
    .filter((m) => buyCostOf(m, rules) <= state.gold + rules.sellGold)
    .map((m) => ({ minion: m, value: minionValue(m, state, deps, rules).total }))
    .sort((a, b) => b.value - a.value);
  const unlocked = buys[affordable(state.gold)] ?? buys.at(-1);
  if (unlocked === undefined) return null;

  const scored = sellable
    .map((minion) => {
      const value = minionValue(minion, { ...state, board: [minion] }, deps, rules);
      // Экономика этой карты — обещание продажи, а не причина держать.
      return { minion, retained: value.total - value.economy };
    })
    .sort((a, b) => a.retained - b.retained);
  const victim = scored[0];
  if (victim === undefined) return null;

  const gain = unlocked.value - victim.retained;
  if (gain <= 0) return null;

  const name = deps.cards.info(victim.minion.cardId)?.name ?? victim.minion.cardId;
  const buyName = deps.cards.info(unlocked.minion.cardId)?.name ?? unlocked.minion.cardId;
  return {
    action: 'sell',
    minion: victim.minion,
    score: gain,
    cost: 0,
    requiresSlot: false,
    sellFirst: null,
    reason:
      `${name} отдаёт обещанное текстом только при продаже, а золото ` +
      `${String(state.gold)} → ${String(state.gold + rules.sellGold)} открывает ещё одну ` +
      `трату (лучшая сейчас — ${buyName}, ${unlocked.value.toFixed(1)}); держать его ` +
      `дальше — ${victim.retained.toFixed(1)} очков телом`,
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
  const cost = rerollCostOf(state, rules);
  if (state.gold < cost) return null;
  // Обновление ради взгляда — потеря золота: найденное должно быть на что
  // купить (part18, ход 7).
  if (!paidRerollIsUseful(state, rules)) return null;

  const best =
    state.shop.length === 0
      ? 0
      : Math.max(...state.shop.map((m) => minionValue(m, state, deps, rules).total));

  // Порог относителен тиру: плоский порог к пятому тиру не срабатывал
  // никогда — любой миньон там дороже шести очков одним тиром.
  const threshold = rules.value.perTechLevel * state.techLevel + rules.rerollMarginOverTier;
  if (best >= threshold) return null;

  // Копим на подъём: если после реролла на него уже не хватит, а сейчас
  // хватает — реролл дороже, чем кажется.
  const upgrade = state.tavernUpgradeCost;
  if (upgrade !== null && state.gold >= upgrade && state.gold - cost < upgrade) {
    return null;
  }

  // До лейта реролл не соревнуется с подъёмом. Мусорная витрина в ранней
  // партии — довод подняться, а не крутить (JeefHS: роллы до лейта
  // запрещены, docs/jeefhs.md; тот же вывод игрока в part11 — «ценны
  // рероллы позже»). Пока подъём доступен и по карману, ход — подъём;
  // обновление советуется уже сдачей после него. Условия зеркалят входные
  // проверки levelUpRule: недоступный подъём реролл не блокирует.
  // Бесплатное обновление с подъёмом не соревнуется вовсе: оно не отнимает
  // золота. Запрет раннего реролла — про трату, а не про сам факт обновления.
  if (
    cost > 0 &&
    state.techLevel < rules.lateRerollTier &&
    upgrade !== null &&
    state.gold >= upgrade &&
    (state.maxTechLevel === null || state.techLevel < state.maxTechLevel) &&
    effectiveHp(state) >= rules.levellingHpFloor
  ) {
    return null;
  }

  return {
    action: 'reroll',
    minion: null,
    score: threshold - best,
    cost,
    requiresSlot: false,
    sellFirst: null,
    reason:
      `лучшее в витрине стоит ${best.toFixed(1)} при пороге ${threshold.toFixed(0)} для тира ` +
      `${String(state.techLevel)} — покупать нечего, обновление ` +
      (cost === 0 ? 'бесплатно' : `стоит ${String(cost)}`),
  };
}

/**
 * Прошёл бы кандидат ту же планку, что при покупке на ПОЛНОМ борде.
 *
 * Планка одна с `buyRules`: тело в полный борд оправдано только явным
 * превосходством над жертвой, и считать его надо против борда БЕЗ жертвы.
 * Копия (тройка или вторая в руку) и магнит слота не требуют вовсе.
 *
 * Заморозке это нужно ровно затем же, зачем покупке: держать витрину ради
 * карты, которую мы сами не купим, — потеря бесплатного обновления. Порог
 * ценности от тира этого не ловит, потому что к концу партии статы витрины
 * растут вместе с бордом: part17, ход 25 — Crackling Cyclone 38/43
 * (56 очков против порога 14) при полном борде из миньонов по 100–800
 * статов, слабейший из которых стоит 150 очков.
 */
function worthFullBoardSlot(
  minion: Minion,
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
): boolean {
  if (state.board.length < rules.boardSize) return true;

  if (minionValue(minion, state, deps, rules).copiesOwned >= 1) return true;
  if (
    isMagnetic(minion, deps.cards) &&
    magnetizeTarget(minion, state.board, deps.cards, poisonAmongSeen(state)) !== null
  ) {
    return true;
  }

  const victim = weakestOwn(state, deps, rules);
  if (victim === null) return true;

  const without = state.board.filter((x) => x.entityId !== victim.minion.entityId);
  const replacing = minionValue(minion, { ...state, board: without }, deps, rules);
  return replacing.total > victim.value + rules.sellMargin;
}

/**
 * Правило заморозки.
 *
 * Незамороженная витрина обновляется в начале хода БЕСПЛАТНО. Значит,
 * заморозка не «сохраняет хорошее», а отказывается от нового даром, и голые
 * статы её не окупают: свежая витрина в среднем не хуже нынешней. Окупает
 * только то, чего свежая витрина не даст, — копия под тройку, миньон
 * племени, которое уже собирается на борде, или заклинание витрины, дающее
 * миньона. И только когда купить это прямо сейчас не хватает золота:
 * что по карману, надо просто покупать.
 */
export function freezeRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  if (state.shop.length === 0) return null;
  if (state.shop.every((m) => m.frozen)) return null;

  const affordable = Math.floor(state.gold / rules.minionCost);

  // Порог относителен тиру таверны, как у реролла: плоский порог к четвёртому
  // тиру пробивала любая дешёвка со статами (part10, Snow Baller).
  const threshold = rules.value.perTechLevel * state.techLevel + rules.freeze.marginOverTier;

  // «Собираемое племя» считается строго: без амальгам и без одноимённых.
  // Амальгама своя для любого племени и потому не признак того, что племя
  // собирается; одноимённая карта — это копия, у копий своя ветка. На part10
  // (ход 3) золотая Aureate Laureate морозилась ради «своих по племени 2»,
  // где свои — она же на борде и амальгама. Одноимённость сверяется по
  // базовому cardId: золотая копия носит суффикс `_G` и без нормализации
  // считалась «другой картой» (ход 13, дракончик при золотом дракончике).
  const baseCardId = (id: string): string => (id.endsWith('_G') ? id.slice(0, -2) : id);
  const strictMates = (candidate: Minion): number => {
    const mine = racesOf(candidate, deps.cards).filter((r) => r !== RACE_ALL);
    return state.board.filter((m) => {
      if (baseCardId(m.cardId) === baseCardId(candidate.cardId)) return false;
      const theirs = racesOf(m, deps.cards).filter((r) => r !== RACE_ALL);
      if (theirs.length === 0) return false;
      if (racesOf(candidate, deps.cards).includes(RACE_ALL)) return true;
      return theirs.some((r) => mine.includes(r));
    }).length;
  };

  // В ход подъёма таверны заморозка ради племени молчит: свежая витрина
  // будет уже НОВОГО тира, и держать старую ради соплеменников — потеря
  // (part11, ход 9: заморозка наги сразу после подъёма на третий тир).
  // Копия под тройку — другое дело: копию не даст и новая витрина.
  const justLevelled = state.techLevelUpTurn === state.turn;

  const valued = state.shop
    .map((m) => {
      const value = minionValue(m, state, deps, rules);
      return {
        minion: m,
        value: value.total,
        copies: value.copiesOwned,
        tier: m.techLevel ?? deps.cards.info(m.cardId)?.techLevel ?? 1,
        mates: justLevelled ? 0 : strictMates(m),
      };
    })
    .sort((a, b) => b.value - a.value);

  // Ценное, до чего в этом ходу руки не дойдут: денег хватает не на всех.
  //
  // Вторая копия (copies === 1) — это ставка на будущую тройку, а не тройка:
  // третью копию ещё предстоит встретить. Такая ставка оправдана только
  // картой не ниже тира таверны — пара дешёвки отнимает бесплатное
  // обновление ради того, что свежая витрина предлагает и так (part15,
  // ход 5: заморозка Buzzing Vermin 1/1 первого тира при таверне 2 — на что
  // игрок и указал). Третья копия (copies >= 2) собирает тройку немедленно
  // и от тира не зависит.
  //
  // Тот же порог тира — и у ветки ПЛЕМЕНИ, и это part22 (ход 5): снова
  // Buzzing Vermin 1/1 первого тира, снова при таверне 2, только на этот
  // раз его держали не как пару, а как «своего по племени» — на борде два
  // зверя. Довод тот же самый: витрина второго тира предложит зверя
  // не хуже, и отдавать за карту НИЖЕ тира бесплатное обновление незачем.
  // Племя тем и отличается от копии, что заменимо: конкретную третью копию
  // ждут, а соплеменника — нет.
  const keepers = valued
    .slice(affordable)
    .filter(
      (v) =>
        v.value >= threshold &&
        (v.copies >= 2 ||
          (v.copies === 1 && v.tier >= state.techLevel) ||
          (v.mates >= rules.freeze.minTribeMates && v.tier >= state.techLevel)) &&
        // Карта, которую мы сами не купим, витрины не стоит: на полном борде
        // она обязана перебивать жертву так же, как при покупке (part17,
        // ход 25 — заморозка Crackling Cyclone 38/43 при борде из сотен).
        worthFullBoardSlot(v.minion, state, deps, rules),
    );
  const best = keepers[0];

  // Заклинание витрины, дающее миньона, — та же «покупка, до которой в этом
  // ходу руки не дошли»: за два золота оно даёт тело, и свежая витрина
  // такого не обещает. Случай part17, ход 1: при нулевом золоте в витрине
  // лежал Enchanted Lasso («Steal a random minion from the Tavern»), и связка
  // «заморозить сейчас — на пять золота купить одного и украсть второго»
  // даёт два тела там, где две покупки стоят шесть. Игрок сыграл её сам;
  // советник заклинания не видел вовсе.
  //
  // Полный борд эту ветку выключает: телу неоткуда взяться месту, а какой
  // миньон придёт — заранее неизвестно, и сравнить его с жертвой нечем.
  //
  // А вот подъём таверны её НЕ выключает, и это правка part19 (ход 3). Запрет
  // на заморозку в ход подъёма — про миньонов: свежая витрина будет нового
  // тира, и держать старых соплеменников ради племени значит менять тир
  // на племя. Заклинания в свежей витрине не будет ВООБЩЕ — ни нового тира,
  // ни старого, — и терять его подъём не повод. Игрок морозил Enchanted Lasso
  // по совету на ходу 1, поднял таверну на ходу 3, и совет исчез, хотя
  // заморозку каждый ход надо продлевать заново, — на что он и указал.
  //
  // Порог у заклинания свой, и это второе следствие того же наблюдения:
  // заклинание — ДОПОЛНИТЕЛЬНОЕ действие, а не замена покупке. Замороженную
  // витрину следующего хода всё так же покупают; теряется не покупка,
  // а РАЗНИЦА между свежей картой нового тира (её и обещает `threshold`)
  // и лучшей из тех, что доживут до следующего хода. Сравнивать двухзолотое
  // тело с целой свежей картой значило требовать от него платы за то, чего
  // заморозка не отнимает.
  //
  // «Доживут» — это `slice(affordable)`, тот же срез, что у миньонов-хранимых:
  // что по карману сегодня, того завтра в витрине уже не будет.
  const bestKept = valued.slice(affordable)[0]?.value ?? 0;
  const spellThreshold = Math.max(0, threshold - bestKept);

  // Сколько покупок игрок сделает в тот ход, ради которого держит витрину.
  // Золото хода таверны N — правило игры, записанное у `tavernTurnOf`:
  // `min(2 + N, 10)`. Нужно затем, что заклинание, крадущее ИЗ ВИТРИНЫ,
  // получит не среднюю её карту, а среднюю из ОСТАВШИХСЯ: лучшие к тому
  // моменту будут куплены.
  const nextGold = Math.min(2 + tavernTurnOf(state.turn) + 1, 10);
  const nextAffordable = Math.floor(nextGold / rules.minionCost);

  const spellKeeper =
    state.board.length >= rules.boardSize
      ? undefined
      : state.shopSpells
          .flatMap((spell) => {
            if (spell.unplayable || spell.cost <= state.gold) return [];
            const effect = spellEffect(spell.cardId, spell.scriptData, deps.cards, rules);
            if (effect === null || !effect.givesMinion) return [];

            // Заморозка судится не сегодняшним золотом, а тем ходом, ради
            // которого держат витрину: там хватит и на покупку, и на неё.
            //
            // Заклинание, крадущее ИЗ ВИТРИНЫ, получает то, что в ней
            // ОСТАНЕТСЯ после покупок того хода: лучшие карты мы к тому
            // моменту купим сами.
            const stealsFromShop = rules.givesMinionFromShopWords.some((w) =>
              new RegExp(w, 'i').test(deps.cards.info(spell.cardId)?.text ?? ''),
            );

            const pool = stealsFromShop
              ? valued.slice(nextAffordable).map((v) => v.minion)
              : state.shop;
            const { score } = givesMinionValue(state, deps, rules, spell.cost, false, pool);
            return score >= spellThreshold ? [{ spell, score: score - spellThreshold }] : [];
          })
          .sort((a, b) => b.score - a.score)[0];

  // Между миньоном и заклинанием выбирает превышение над своим порогом:
  // пороги у них разные, и сравнивать сырые очки значило бы сравнивать
  // ответы на разные вопросы.
  if (
    spellKeeper !== undefined &&
    (best === undefined || spellKeeper.score > best.value - threshold)
  ) {
    const spellName =
      deps.cards.info(spellKeeper.spell.cardId)?.name ?? spellKeeper.spell.cardId;
    return {
      action: 'freeze',
      minion: null,
      spellCardId: spellKeeper.spell.cardId,
      score: spellKeeper.score,
      cost: 0,
      requiresSlot: false,
      sellFirst: null,
      reason:
        `${spellName} за ${String(spellKeeper.spell.cost)} даёт миньона, а золота ` +
        `${String(state.gold)} на него не хватает; со следующего хода это ` +
        `покупка и заклинание в один ход — два тела вместо одного`,
    };
  }

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
    score: best.value - threshold,
    cost: 0,
    requiresSlot: false,
    sellFirst: null,
    reason:
      `${name} — ${why}, а золота ${String(state.gold)} хватает лишь на ` +
      `${String(affordable)} покупок; свежая витрина такого не обещает`,
  };
}

/**
 * Правило силы героя.
 *
 * Советуется только сила, которая ДАЁТ МИНЬОНА, — это видно по тексту
 * (`heroPowerMinionWords`). Скаббс: покупка за 3 плюс сила за 2 — два
 * существа за 5 золота. Про урон, баффы и прочее совет не берётся судить.
 *
 * Ценность — как у среднего миньона витрины: сила приносит существо того же
 * разбора, а стоит дешевле покупки. Нажатая в этом ходу или заблокированная
 * сила не советуется: и то и другое читается из лога (блок PLAY на сущности
 * силы, тег LITERALLY_UNPLAYABLE).
 */
/**
 * Ценность действия «даёт миньона» — силы героя или заклинания витрины.
 *
 * Приходящий миньон — из той же витрины, поэтому его ценность оценивается
 * СРЕДНИМ по витрине. У «Enchanted Lasso» («Steal a random minion from the
 * Tavern») это не приближение, а точное ожидание: миньон берётся случайным
 * из тех же карт, что мы уже оценили. Второе слагаемое — сэкономленное
 * золото: действие дешевле покупки, а золото переводится в очки курсом
 * `goldPointValue`.
 *
 * Скидка засчитывается не всегда, и это не мелочь: при трёх золотых
 * и заклинании за два остаётся золотой, который просто сгорит, — «дешевле
 * покупки» превращается в «слабее покупки», и совет обязан ставить обычную
 * покупку выше. Поэтому у действия ПРЯМО СЕЙЧАС (`spendNow`) скидка
 * считается, только если остатка хватает ещё на покупку. У заморозки
 * наоборот: она и есть ставка на ход, где золота хватит на оба действия,
 * — там скидка и есть весь смысл (part17, ход 1: заморозить при нулевом
 * золоте, чтобы на пяти купить одного и украсть второго).
 *
 * `pool` — из чего именно придёт миньон. По умолчанию это вся витрина, и для
 * «Get a random minion» так и есть. Но «Steal a random minion FROM THE
 * TAVERN» (Enchanted Lasso) берёт из ТОЙ ЖЕ витрины, которую мы сейчас
 * оцениваем, — а к моменту применения лучшие карты из неё уже куплены.
 * Считать ожидание по всей витрине значило считать лучшую карту дважды:
 * и «мы её купим», и «лассо может её дать». Случай part22 (ход 7 и дальше):
 * игрок про повторяющийся совет заморозить лассо сказал «не вижу
 * практического эффекта от этой карты» — и был прав ровно этим.
 */
function givesMinionValue(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules,
  cost: number,
  spendNow: boolean,
  pool: readonly Minion[] = state.shop,
): { readonly score: number; readonly average: number; readonly discounted: boolean } {
  const shopValues = pool.map((m) => minionValue(m, state, deps, rules).total);
  const average =
    shopValues.length > 0
      ? shopValues.reduce((a, b) => a + b, 0) / shopValues.length
      : rules.value.perTechLevel * state.techLevel;

  const discounted = !spendNow || state.gold - cost >= rules.minionCost;
  const cheaper = discounted ? Math.max(0, rules.minionCost - cost) * rules.goldPointValue : 0;
  return { score: average + cheaper, average, discounted };
}

export function heroPowerRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  const hero = state.hero;
  if (hero === null || hero.heroPowerCardId === null) return null;

  const cost = hero.heroPowerCost;
  if (cost === null || cost <= 0) return null;
  if (hero.heroPowerUsedThisTurn || hero.heroPowerUnplayable) return null;
  if (cost > state.gold) return null;

  const info = deps.cards.info(hero.heroPowerCardId);
  const text = info?.text ?? '';
  if (!rules.givesMinionWords.some((w) => new RegExp(w, 'i').test(text))) return null;

  const { score, average, discounted } = givesMinionValue(state, deps, rules, cost, true);

  return {
    action: 'heroPower',
    minion: null,
    score,
    cost,
    requiresSlot: false,
    sellFirst: null,
    reason:
      `${info?.name ?? hero.heroPowerCardId} за ${String(cost)} даёт миньона — ` +
      `как средний из витрины (${average.toFixed(1)})` +
      (discounted && cost < rules.minionCost
        ? `, но на ${String(rules.minionCost - cost)} золота дешевле покупки`
        : ''),
  };
}

/**
 * Правило бесплатной силы героя.
 *
 * Прежнее правило силы отсекает бесплатные на входе (`cost > 0`): оно про
 * «сила как дешёвая покупка миньона». Но бесплатную активную силу игрок
 * просто забывает нажать — как монетку в руке. Случай part13 (Хроми,
 * «Мана в минуту»: «Refresh the Tavern with Tavern spells», HAS_ACTIVATE_POWER
 * без тега COST): за партию совет не напомнил про силу ни разу — на что
 * игрок и указал.
 *
 * Советуется только бесплатная И активная сила с текстом про обновление
 * витрины (`heroPowerRefreshWords`): про платные и пассивные вне «даёт
 * миньона» совет по-прежнему не берётся судить. Очки малые — напоминание
 * всплывает, когда покупки сделаны и список пустеет, то есть к концу хода.
 */
export function freeHeroPowerRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  const hero = state.hero;
  if (hero === null || hero.heroPowerCardId === null) return null;
  if (!hero.heroPowerHasActivate) return null;
  if ((hero.heroPowerCost ?? 0) > 0) return null;
  if (hero.heroPowerUsedThisTurn || hero.heroPowerUnplayable) return null;

  const info = deps.cards.info(hero.heroPowerCardId);
  const text = info?.text ?? '';
  if (!rules.heroPowerRefreshWords.some((w) => new RegExp(w, 'i').test(text))) return null;

  return {
    action: 'heroPower',
    minion: null,
    score: rules.freeHeroPowerValue,
    cost: 0,
    requiresSlot: false,
    sellFirst: null,
    reason:
      `${info?.name ?? hero.heroPowerCardId} бесплатна и обновляет витрину — ` +
      'нажать, когда нынешняя витрина отработана',
  };
}

/**
 * Правило силы героя, дающей заклинание таверны.
 *
 * Случай part15 (Холли'дэй, «Благословение девяти лягушек»: «Get a random
 * Tavern spell», HAS_ACTIVATE_POWER, COST=1): на ходу 7 у игрока оставалось
 * 1 золото, совет молчал, и золото сгорало — на что игрок и указал.
 *
 * Ценность — примерно цена заклинания таверны в витрине (два золота
 * по курсу), очки — ценность минус цена силы. При силе за 1 очков мало,
 * и совет всплывает к концу хода, когда крупные траты сделаны, — ровно
 * как напоминание о бесплатной силе. Про платные силы вне «даёт миньона»
 * и «даёт заклинание» совет по-прежнему не берётся судить.
 */
export function heroPowerSpellRule(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  const hero = state.hero;
  if (hero === null || hero.heroPowerCardId === null) return null;
  if (!hero.heroPowerHasActivate) return null;
  if (hero.heroPowerUsedThisTurn || hero.heroPowerUnplayable) return null;

  const cost = hero.heroPowerCost ?? 0;
  // Бесплатные силы живут в freeHeroPowerRule; здесь — платная экономика.
  if (cost <= 0 || cost > state.gold) return null;

  const info = deps.cards.info(hero.heroPowerCardId);
  const text = info?.text ?? '';
  if (!rules.heroPowerSpellWords.some((w) => new RegExp(w, 'i').test(text))) return null;

  const score = rules.heroPowerSpellValue - cost * rules.goldPointValue;
  if (score <= 0) return null;

  return {
    action: 'heroPower',
    minion: null,
    score,
    cost,
    requiresSlot: false,
    sellFirst: null,
    reason:
      `${info?.name ?? hero.heroPowerCardId} за ${String(cost)} даёт заклинание таверны — ` +
      'оно стоит дороже своей цены, нажать, пока золото не сгорело',
  };
}

/**
 * Правило активаций миньонов.
 *
 * «Activate (N): …» — способность своего миньона на борде за золото.
 * Фактура part14 (Suspicious Prisonguard): активируемость — тег
 * `HAS_ACTIVATE_POWER` на миньоне; цена — живой тег
 * `INTERACTABLE_OBJECT_COST` (сходится с плейсхолдером «Activate ({2})» →
 * `TAG_SCRIPT_DATA_NUM_3`); применение — блок `BlockType=PLAY` на сущности,
 * СТОЯЩЕЙ в `PLAY`. Игрок указал, что активации не советовались вовсе —
 * прежде они были отложены с фактурой part8.
 *
 * Эффект читается из текста тем же разбором, что у заклинаний: бафф-статы
 * («Give another minion +{0}/+{1}», плейсхолдеры — теги NUM самого миньона)
 * и получение миньона («Get a random Murloc»). Про остальное — кражи,
 * поглощения, сложные симбиозы — совет честно не берётся судить, как
 * и с силами героя.
 */
export function activationRules(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation[] {
  return state.board.flatMap((minion) => {
    if ((minion.tags['HAS_ACTIVATE_POWER'] ?? 0) <= 0) return [];
    if (state.activatedEntityIds.includes(minion.entityId)) return [];
    if ((minion.tags['LITERALLY_UNPLAYABLE'] ?? 0) > 0) return [];
    const cost = minion.tags['INTERACTABLE_OBJECT_COST'] ?? 0;
    if (cost > state.gold) return [];

    const info = deps.cards.info(minion.cardId);
    const text = info?.text ?? '';
    const activate = /activate \([^)]*\):([\s\S]*)$/i.exec(text);
    if (activate?.[1] === undefined) return [];
    const effectText = activate[1];

    // Тот же разбор, что у заклинаний: литералы и плейсхолдеры-индексы
    // в теги NUM — только теги здесь живут на самом миньоне.
    let stats = 0;
    for (const m of effectText.matchAll(/\+(?:\{(\d)\}|(\d+))/g)) {
      const placeholder = m[1];
      const literal = m[2];
      if (placeholder !== undefined) stats += minion.scriptData[Number(placeholder)] ?? 0;
      else if (literal !== undefined) stats += Number(literal);
    }
    const givesMinion = /\b(?:get|summon|discover)\b/i.test(effectText);

    const name = info?.name ?? minion.cardId;
    let score = 0;
    let what = '';
    if (stats > 0) {
      score = stats * rules.value.perStatPoint - cost * rules.goldPointValue;
      what = `+${String(stats)} статов`;
    } else if (givesMinion) {
      // Приносимое тело оценивается как средний миньон текущего тира.
      score = rules.value.perTechLevel * state.techLevel - cost * rules.goldPointValue;
      what = 'принесёт миньона';
    }
    if (score <= 0) return [];

    // Цель баффа — крупнейший свой, кроме самого активирующего:
    // «Give another minion…».
    const others = state.board.filter((m) => m.entityId !== minion.entityId);
    const target =
      stats > 0 && others.length > 0
        ? others.reduce((a, b) =>
            (b.attack ?? 0) + (b.health ?? 0) > (a.attack ?? 0) + (a.health ?? 0) ? b : a,
          )
        : null;

    return [
      {
        action: 'activate' as const,
        minion,
        score,
        cost,
        requiresSlot: false,
        sellFirst: null,
        targetMinion: target,
        reason: `активация ${name} за ${String(cost)}: ${what}`,
      },
    ];
  });
}

/**
 * Эффект заклинания, восстановленный из текста карты и тегов сущности.
 *
 * Плейсхолдеры `{0}`/`{1}` в тексте снапшота — это индексы значений
 * `TAG_SCRIPT_DATA_NUM_1..2` на сущности (part10: у «Buy the Holy Light»
 * текст «+{0} Attack», а 10 лежит в NUM_1; у Тавматургии «+{1}/+{1}»
 * и единица в NUM_2). Литеральные числа встречаются реже («+1/+1»).
 * Что не разобралось — честный `null`: совет не берётся судить.
 */
export interface SpellEffect {
  /** Золото, которое даст розыгрыш: «Gain 1 Gold» у монетки таверны. */
  readonly gold: number;
  /** Сумма статов усиления: «+{0} Attack», «+X/+Y». */
  readonly stats: number;
  /**
   * Та часть `stats`, которая ВЫВЕТРИТСЯ: «+2 Attack until next turn»
   * (Mini-Trident и остальные четыре временных чародейских токена пула).
   *
   * Считается по предложению, где стоят сами статы, а не по всему тексту:
   * у Undersea Mount («Give a minion +{0}/+{1}. If it's a Naga, also give
   * it Windfury until next turn») временна только вихревая часть.
   *
   * Нужно выбору цели: временное усиление имеет смысл класть на носителя,
   * который делает его постоянным (Lava Lurker, part21).
   */
  readonly temporaryStats: number;
  /** Даёт ли божественный щит. */
  readonly divineShield: boolean;
  /**
   * Заклинание уничтожает СВОЕГО миньона — «Destroy a friendly …».
   *
   * Это переворачивает смысл цели: у баффа цель — кого усилить, здесь —
   * кем пожертвовать. «Разделка туши» (part13, ход 21) советовалась
   * «на» крупнейшего своего — то есть предлагала уничтожить главную карту
   * борда, к тому же не проходящую по племени.
   */
  readonly destroysFriendly: boolean;
  /** Племя жертвы — ключ `races` снапшота; `null` — любое. */
  readonly destroyRace: string | null;
  /**
   * Замена: уничтоженному взамен приходит новый миньон («…to get a random
   * Undead»). Заклинание наклейки Тюремщика (part14): ни статов, ни золота
   * в тексте нет, и прежний разбор возвращал null — совет молчал всю партию,
   * хотя бесплатная замена слабейшей нежити на случайную почти всегда апгрейд.
   */
  readonly transforms: boolean;
  /**
   * Даёт провокацию («…and Taunt»). Провокация зовёт удары на носителя,
   * и выбор цели обязан это учитывать: движок с постоянным эффектом
   * в приоритет ударов не подставляется (part15, ход 19).
   */
  readonly grantsTaunt: boolean;
  /**
   * Цель НЕ выбирается: игра распределяет эффект сама («of each type»,
   * «random», «left-most»). Совет с «→ на кого-то» показывал бы выбор,
   * которого у игрока нет (part15, ход 19: Misplaced Tea Set).
   */
  readonly untargeted: boolean;
  /**
   * Заклинание ДАЁТ МИНЬОНА — то же, что покупка, только дешевле трёх
   * (`givesMinionWords`). «Enchanted Lasso» за 2: «Steal a random minion
   * from the Tavern» (part17, ход 1). Ни статов, ни золота в тексте нет,
   * и прежний разбор возвращал null — заклинание было невидимо целиком.
   */
  readonly givesMinion: boolean;
  /**
   * Ветви модального заклинания «Choose One», в порядке снапшота.
   *
   * Пусто у обычного заклинания. У модального остальные поля эффекта —
   * это поля ВЫБРАННОЙ ветви (`chosen`), а не суммы обеих: суммировать
   * их было тихо неверно («+{0}/+{1}; or +{2}/+{3}» у Alliance Flag
   * складывалось в +8 статов вместо +4).
   */
  readonly branches: readonly SpellBranch[];
  /**
   * Индекс выбранной ветви, или `null` — ветви равны по нашей шкале
   * и разделить их нечем. Тогда эффект взят от первой (они равны),
   * а совет честно называет обе.
   */
  readonly chosen: number | null;
}

/** Ветвь «Choose One» — отдельная карта снапшота (`…t` и `…t2`). */
export interface SpellBranch {
  readonly cardId: string;
  readonly name: string;
  /** Короткая подпись действия: «+3/+1» у Allied Mace. Пусто, если не статы. */
  readonly label: string;
}

/**
 * Пара «+X/+Y» из текста: атака и здоровье по отдельности.
 *
 * Сумма статов для оценки и так считается, а раздельные числа нужны двум
 * вещам: подписать ветвь «Choose One» словами игрока («+3/+1») и разделить
 * ветви с одинаковой суммой (`buffSplitPreference`). Плейсхолдер — индекс
 * в теги сущности, как везде.
 */
function statPair(
  text: string,
  scriptData: readonly (number | null)[],
): { readonly attack: number; readonly health: number } | null {
  const m = /\+(?:\{(\d)\}|(\d+))\s*\/\s*\+(?:\{(\d)\}|(\d+))/.exec(text);
  if (m === null) return null;
  const num = (placeholder: string | undefined, literal: string | undefined): number =>
    placeholder === undefined ? Number(literal ?? 0) : (scriptData[Number(placeholder)] ?? 0);
  return { attack: num(m[1], m[2]), health: num(m[3], m[4]) };
}

/**
 * Очки ветви — только чтобы сравнить ветви между собой.
 *
 * Настоящая ценность заклинания считается в `spellRules`/`shopSpellRules`
 * с ценой и состоянием; здесь нужен один скаляр на ветвь, и он собран
 * из тех же весов. «Даёт миньона» оценивается ценой покупки: точную
 * ценность (среднее по витрине) отсюда не видно — витрины у разбора нет.
 */
function branchScore(effect: SpellEffect, rules: TavernRules): number {
  return (
    (effect.transforms ? rules.value.transform : 0) +
    effect.stats * rules.value.perStatPoint +
    (effect.divineShield ? rules.value.divineShield : 0) +
    (effect.grantsTaunt ? rules.value.taunt : 0) +
    effect.gold * rules.goldPointValue +
    (effect.givesMinion ? rules.minionCost * rules.goldPointValue : 0)
  );
}

/**
 * Модальное заклинание «Choose One»: какую ветвь советовать.
 *
 * Ветви лежат в снапшоте отдельными картами с теми же плейсхолдерами:
 * `BG31_880` («Choose One — Give a minion +{0}/+{1}; or +{2}/+{3}») — это
 * `BG31_880t` (Allied Mace, «+{0}/+{1}») и `BG31_880t2` (Allied Buckler,
 * «+{2}/+{3}»). Соглашение проверено на всех пяти модальных заклинаниях
 * пула; порядок ветвей в тексте родителя с порядком карт не совпадает
 * (у Boundless Potential наоборот), поэтому читается текст каждой ветви,
 * а не позиция.
 *
 * Случай part19 (ход 7): совет «РАЗЫГРАТЬ Alliance Flag → на Wrath Weaver»
 * молчал о том, какой из двух эффектов брать, — игрок остался с выбором
 * один на один, на что и указал. Заодно чинится тихий просчёт: сумма
 * статов родителя складывала ОБЕ ветви (+3/+1 и +1/+3 = +8 статов вместо
 * реальных +4).
 *
 * Выбор: сперва по нашей же шкале; при равенстве — по разделению статов
 * (`buffSplitPreference`, замер `npm run spike:buff`); если и это не
 * разделяет — `chosen: null`, и совет честно называет обе ветви.
 */
function chooseOneEffect(
  cardId: string,
  scriptData: readonly (number | null)[],
  cards: CardIndex,
  rules: TavernRules,
): SpellEffect | null {
  const all = ['t', 't2']
    .map((suffix) => cards.info(cardId + suffix))
    .flatMap((info) => {
      if (info === null) return [];
      const pair = statPair(info.text ?? '', scriptData);
      return [
        {
          effect: spellEffect(info.id, scriptData, cards, rules),
          pair,
          branch: {
            cardId: info.id,
            name: info.name,
            label: pair === null ? '' : `+${String(pair.attack)}/+${String(pair.health)}`,
          },
        },
      ];
    });

  const branches = all.map((p) => p.branch);
  const parsed = all.flatMap((p) => (p.effect === null ? [] : [{ ...p, effect: p.effect }]));
  const first = parsed[0];
  if (first === undefined) return null;

  // Одну из ветвей разобрать не вышло — сравнивать не с чем. «Не берёмся
  // судить» здесь честнее, чем «берите ту, которую поняли»: у Boundless
  // Potential это «Discover a minion of your Tier» против «a Tavern spell
  // of your Tier», и неоценённая ветвь не значит худшую. Очки при этом
  // берутся от разобранной — иначе заклинание пропало бы из советов вовсе.
  if (parsed.length < all.length) {
    return { ...first.effect, branches, chosen: branches.length === 1 ? 0 : null };
  }
  if (parsed.length === 1) return { ...first.effect, branches, chosen: 0 };

  const scores = parsed.map((p) => branchScore(p.effect, rules));
  const bestScore = Math.max(...scores);
  const leaders = scores.flatMap((s, i) => (s === bestScore ? [i] : []));

  if (leaders.length === 1) {
    const only = leaders[0] ?? 0;
    return { ...(parsed[only]?.effect ?? first.effect), branches, chosen: only };
  }

  // Ветви равны по шкале: разделить их может только разделение статов —
  // одна и та же сумма, розданная по-разному (+3/+1 против +1/+3).
  const preference = rules.buffSplitPreference;
  if (preference !== null) {
    const split = leaders.flatMap((i) => {
      const pair = parsed[i]?.pair;
      return pair === undefined || pair === null ? [] : [{ i, pair }];
    });
    if (split.length === leaders.length && split.length > 1) {
      const key = (p: { attack: number; health: number }): number =>
        preference === 'attack' ? p.attack : p.health;
      const best = split.reduce((a, b) => (key(b.pair) > key(a.pair) ? b : a));
      const worst = split.reduce((a, b) => (key(b.pair) < key(a.pair) ? b : a));
      if (key(best.pair) > key(worst.pair)) {
        return { ...(parsed[best.i]?.effect ?? first.effect), branches, chosen: best.i };
      }
    }
  }

  // Разделить нечем. Эффект берётся от первой ветви — они равны, и это
  // всё равно честнее суммы обеих, — а совет называет обе.
  return { ...first.effect, branches, chosen: null };
}

/**
 * Временно ли усиление, стоящее в тексте на позиции `index`.
 *
 * Смотрится ПРЕДЛОЖЕНИЕ, в котором стоят статы, а не весь текст: у Undersea
 * Mount «Give a minion +{0}/+{1}. If it's a Naga, also give it Windfury
 * until next turn» статы постоянны, а временна вихревая половина. Поиск
 * по всему тексту пометил бы временными и статы — тихо и неверно.
 */
function isTemporaryClause(text: string, index: number, rules: TavernRules): boolean {
  const rest = text.slice(index);
  const stop = rest.search(/[.;]/);
  const clause = stop === -1 ? rest : rest.slice(0, stop);
  return rules.temporaryBuffWords.some((w) => new RegExp(w, 'i').test(clause));
}

/**
 * Чародейское ли это заклинание.
 *
 * Слова «Spellcraft» в тексте самого токена нет — оно стоит у миньона,
 * который его выдаёт. Зато держится соглашение идентификаторов, то же,
 * что у ветвей «Choose One» (part19): токен чародейства — это `<id миньона>t`
 * (Mini-Myrmidon `BG23_000` → Mini-Trident `BG23_000t`, золотой
 * `BG23_000_Gt`). Проверено на ВСЕХ 22 чародеях пула — у каждого есть
 * свой токен, и других карт с таким id нет.
 */
function isSpellcraftSpell(cardId: string | null, cards: CardIndex): boolean {
  if (cardId === null || !cardId.endsWith('t')) return false;
  const source = cards.info(cardId.slice(0, -1));
  return source?.mechanics.includes('BACON_SPELLCRAFT_ID') ?? false;
}

/**
 * «Магнит заклинаний» — миньон, чей текст говорит о заклинании, применённом
 * К НЕМУ САМОМУ, и сколько СТАТОВ даст сверх усиления попадание именно в него.
 *
 * Случай part21 (ход 9): план советовал купить Lava Lurker («The first
 * Spellcraft spell played from hand on this each turn is permanent»)
 * и тут же играл Mini-Trident мимо него — в крупнейшее тело борда. Цель
 * выбиралась по размеру, и обе стороны дела советник не видел вовсе:
 * ни того, что трезубец ВЫВЕТРИТСЯ («+2 Attack until next turn»),
 * ни того, что на скрытне он останется навсегда.
 *
 * Считается только то, что читается числами:
 *
 * - ХРАНИТЕЛЬ («…is permanent») превращает временную часть усиления
 *   в постоянную — выгода равна `temporaryStats`. Требуется, чтобы
 *   заклинание было чародейским (так написано в тексте) и чтобы дневной
 *   счётчик («({0} left!)» — живой тег сущности) не был исчерпан;
 * - РАСТУЩИЙ («…gain +{0} Health») получает свои статы с любого заклинания.
 *
 * Остальные пять магнитов пула (копия заклинания, кровавый камень соседям,
 * усиление витрины, миньона в руке, чужое заклинание) числом не мерятся —
 * у них выгода `0`, и цель выбирается как прежде, по телу. Это честнее
 * выдуманного веса: «не берёмся судить» здесь то же, что у сложных активаций.
 */
export function spellMagnetGain(
  target: Minion,
  effect: SpellEffect,
  spellCardId: string | null,
  cards: CardIndex,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): {
  readonly gain: number;
  readonly note: string;
  /** Выгода взята у ХРАНИТЕЛЯ, и его дневной заряд на этом тратится. */
  readonly spendsCharge?: boolean;
} | null {
  // Текст справочник уже нормализовал: приклеенный золотой вариант отрезан
  // при загрузке снапшота (`normalizeCardText`, part17).
  const text = cards.info(target.cardId)?.text ?? '';
  if (text === '') return null;
  if (!rules.spellMagnetWords.some((w) => new RegExp(w, 'i').test(text))) return null;

  if (rules.spellMagnetPermanentWords.some((w) => new RegExp(w, 'i').test(text))) {
    // Счётчик оставшихся на этот ход — тот же плейсхолдер «({0} left!)».
    // Тега нет — считаем, что заряд есть: отсутствие тега не значит ноль.
    const left = target.scriptData[0] ?? 1;
    if (!isSpellcraftSpell(spellCardId, cards) || effect.temporaryStats <= 0 || left <= 0) {
      return { gain: 0, note: '' };
    }
    return {
      gain: effect.temporaryStats,
      note: `усиление на нём останется навсегда (+${String(effect.temporaryStats)} статов)`,
      spendsCharge: true,
    };
  }

  if (rules.spellMagnetGainWords.some((w) => new RegExp(w, 'i').test(text))) {
    const m = /\bgain\s+\+(?:\{(\d)\}|(\d+))(?:\s*\/\s*\+(?:\{(\d)\}|(\d+)))?/i.exec(text);
    if (m === null) return { gain: 0, note: '' };
    const num = (placeholder: string | undefined, literal: string | undefined): number =>
      placeholder === undefined
        ? Number(literal ?? 0)
        : (target.scriptData[Number(placeholder)] ?? 0);
    const gain = num(m[1], m[2]) + num(m[3], m[4]);
    return gain <= 0
      ? { gain: 0, note: '' }
      : { gain, note: `растёт от заклинаний (+${String(gain)} статов)` };
  }

  return { gain: 0, note: '' };
}

export function spellEffect(
  cardId: string,
  scriptData: readonly (number | null)[],
  cards: CardIndex,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): SpellEffect | null {
  const info = cards.info(cardId);
  const text = info?.text ?? '';
  if (text === '') return null;

  // Модальное заклинание разбирается по ветвям, а не по склеенному тексту
  // родителя. Рекурсии тут нет: у самих ветвей механики CHOOSE_ONE нет.
  if (info?.mechanics.includes('CHOOSE_ONE') === true) {
    const modal = chooseOneEffect(cardId, scriptData, cards, rules);
    if (modal !== null) return modal;
  }

  const gold = /gain (\d+) gold/i.exec(text);

  // Числа усиления: литерал или плейсхолдер-индекс в теги сущности.
  // Заодно считается, сколько из них выветрится: пометка временности
  // относится к СВОЕМУ предложению, а не ко всему тексту карты.
  let stats = 0;
  let temporaryStats = 0;
  for (const m of text.matchAll(/\+(?:\{(\d)\}|(\d+))/g)) {
    const placeholder = m[1];
    const literal = m[2];
    const value =
      placeholder !== undefined
        ? (scriptData[Number(placeholder)] ?? 0)
        : literal !== undefined
          ? Number(literal)
          : 0;
    stats += value;
    if (isTemporaryClause(text, m.index, rules)) temporaryStats += value;
  }
  const shield = /divine shield/i.test(text);

  // «Destroy a friendly Undead» — слово после «friendly» сверяется с той же
  // таблицей слов племён, что у тринкетов; не совпало ни с чем — жертва любая.
  const destroy = /destroys? a friendly(?:\s+([a-z]+))?/i.exec(text);
  let destroyRace: string | null = null;
  if (destroy !== null && destroy[1] !== undefined) {
    for (const [race, pattern] of Object.entries(rules.tribeTextWords)) {
      if (new RegExp(`^(?:${pattern})$`, 'i').test(destroy[1])) {
        destroyRace = race;
        break;
      }
    }
  }

  // Замена: за уничтожением следует получение — «…to get a random Undead»
  // (заклинание наклейки Тюремщика, part14).
  const transforms = destroy !== null && /to (?:get|summon|discover)/i.test(text);

  const grantsTaunt = /\btaunt\b/i.test(text);

  // «Цель не выбирается» имеет смысл только у усилений: у замены выбор
  // жертвы и так наш, у золота цели нет вовсе.
  const untargeted =
    destroy === null && rules.untargetedSpellWords.some((w) => new RegExp(w, 'i').test(text));

  // «Даёт миньона» — та же таблица шаблонов, что у силы героя: факт записан
  // в тексте, а не в том, кто его произносит. Замена («…destroy … to get
  // a random Undead») сюда не относится — у неё своя ветка с жертвой.
  const givesMinion =
    !transforms && rules.givesMinionWords.some((w) => new RegExp(w, 'i').test(text));

  if (gold === null && stats === 0 && !shield && !transforms && !grantsTaunt && !givesMinion) {
    return null;
  }
  return {
    gold: gold?.[1] === undefined ? 0 : Number(gold[1]),
    stats,
    temporaryStats,
    divineShield: shield,
    destroysFriendly: destroy !== null,
    destroyRace,
    transforms,
    grantsTaunt,
    untargeted,
    givesMinion,
    branches: [],
    chosen: null,
  };
}

/**
 * Миньон-«движок»: его ценность — постоянный эффект из текста (аура,
 * «After/Whenever/At the start…»), а не размен телом. Признаки — механика
 * AURA в снапшоте и слова из `engineTextWords`.
 *
 * Триггер О СЕБЕ движком не считается: «After this attacks and kills
 * a minion…» (Wildfire Elemental) — описание собственного размена, а не
 * эффекта, который надо беречь от ударов. Прежнее правило зачисляло такого
 * бойца в движки словом «After» и уводило провокацию на токен (part17,
 * ход 11).
 */
function isEffectEngine(m: Minion, cards: CardIndex, rules: TavernRules): boolean {
  const info = cards.info(m.cardId);
  if (info?.mechanics.includes('AURA') ?? false) return true;
  const text = info?.text ?? '';
  if (text === '') return false;
  if (rules.selfTriggerWords.some((w) => new RegExp(w, 'i').test(text))) return false;
  return rules.engineTextWords.some((w) => new RegExp(w, 'i').test(text));
}

/**
 * В кого целить заклинание с целью на своём борде.
 *
 * Бафф идёт на крупнейшего своего — усиление достаётся тому, кто дольше
 * живёт в бою (точечный выбор правила не судят, сказано в docs). Заклинание
 * с «Destroy a friendly …» целится наоборот: жертва — НАИМЕНЬШИЙ свой
 * подходящего племени. `null` — целить не в кого, и советовать такое
 * заклинание нельзя вовсе: у «Разделки туши» без нежити на борде нет
 * ни жертвы, ни выгоды.
 *
 * Два уточнения по part15 (ход 19):
 *
 * - у заклинания БЕЗ выбора цели (`untargeted`) цель не называется вовсе —
 *   «Misplaced Tea Set» раздаёт «по миньону каждого племени» сам,
 *   и «→ на Deathstrider» показывал выбор, которого нет;
 * - провокация не вешается на миньона-«движка»: она зовёт удары, а ценность
 *   движка — эффект, и подставлять его — терять эффект. «Slimy Shield»
 *   советовался на Deathstrider — игрок прямо сказал, что не хочет его
 *   в приоритете ударов. Цель — крупнейший из остальных; если весь борд
 *   из движков, выбор честно возвращается к крупнейшему.
 *
 * И третье, по part17 (ход 11): усиление остаётся на миньоне НАВСЕГДА,
 * поэтому оно не вешается на кандидата в продажу — слабейшего своего,
 * которого правила сами назовут жертвой при первой покупке на полный борд.
 * «Fortify» советовался на Water Droplet 3/3 — токен, который игрок,
 * по его словам, и так собирался продать.
 */
function spellTargetOn(
  effect: SpellEffect,
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
  spellCardId: string | null = null,
): {
  readonly target: Minion | null;
  readonly note: string;
  readonly spendsCharge?: boolean;
} | null {
  const cards = deps.cards;
  if (state.board.length === 0) return null;

  if (effect.destroysFriendly) {
    const eligible = state.board.filter((m) => {
      if (effect.destroyRace === null) return true;
      const races = racesOf(m, cards);
      return races.includes(RACE_ALL) || races.includes(effect.destroyRace);
    });
    if (eligible.length === 0) return null;
    const victim = eligible.reduce((a, b) =>
      (b.attack ?? 0) + (b.health ?? 0) < (a.attack ?? 0) + (a.health ?? 0) ? b : a,
    );
    const name = cards.info(victim.cardId)?.name ?? victim.cardId;
    return {
      target: victim,
      note: effect.transforms
        ? `заменит ${name} — наименьшего своего подходящего — на случайного нового`
        : `в жертву ${name} — наименьший свой подходящий`,
    };
  }

  if (effect.untargeted) {
    return { target: null, note: 'цель не выбирается — заклинание распределяет само' };
  }

  const largest = (list: readonly Minion[]): Minion =>
    list.reduce((a, b) =>
      (b.attack ?? 0) + (b.health ?? 0) > (a.attack ?? 0) + (a.health ?? 0) ? b : a,
    );

  let pool: readonly Minion[] = state.board;
  const notes: string[] = [];

  if (effect.grantsTaunt) {
    const bodies = pool.filter((m) => !isEffectEngine(m, cards, rules));
    if (bodies.length > 0 && bodies.length < pool.length) {
      pool = bodies;
      notes.push('провокация зовёт удары, миньоны-эффекты не подставляются');
    }
  }

  // Кандидат в продажу — тот же слабейший свой, которого назовёт покупка
  // на полный борд. Усиление на нём уйдёт вместе с ним.
  const victim = weakestOwn(state, deps, rules);
  if (victim !== null) {
    const keepers = pool.filter((m) => m.entityId !== victim.minion.entityId);
    if (keepers.length > 0 && keepers.length < pool.length) {
      pool = keepers;
      notes.push('усиление навсегда — не на кандидата в продажу');
    }
  }

  // Магнит заклинаний бьёт размер тела: попадание в него даёт СВЕРХ усиления
  // ещё статы, и они считаются числом, а не мнением (part21, ход 9 — Lava
  // Lurker делает трезубец постоянным, Fleeing Fugitive растёт на +1).
  // Правило «крупнейший» им не соперник: наши же docs говорят, что кому
  // полезнее усиление, правила не судят, — а тут выгода читается.
  const magnets = pool.map((m) => ({
    minion: m,
    gain: spellMagnetGain(m, effect, spellCardId, cards, rules),
  }));
  const bestGain = Math.max(0, ...magnets.map((x) => x.gain?.gain ?? 0));
  let spendsCharge = false;
  if (bestGain > 0) {
    const best = magnets.filter((x) => (x.gain?.gain ?? 0) === bestGain);
    pool = best.map((x) => x.minion);
    const note = best[0]?.gain?.note;
    if (note !== undefined && note !== '') notes.push(note);
    spendsCharge = best[0]?.gain?.spendsCharge ?? false;
  }

  const target = largest(pool);
  const name = cards.info(target.cardId)?.name ?? target.cardId;
  return {
    target,
    note: `цель — ${name}` + (notes.length > 0 ? `: ${notes.join('; ')}` : ''),
    spendsCharge,
  };
}

/**
 * Кого усилит заклинание-бафф — та же цель, что называют советы.
 *
 * Нужно замеру `spike:buff`: он сравнивает «+3/+1 против +1/+3» ровно
 * на том миньоне, которого выберет советник, а не на произвольном.
 */
export function buffTarget(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Minion | null {
  const buff: SpellEffect = {
    gold: 0,
    stats: 4,
    temporaryStats: 0,
    divineShield: false,
    destroysFriendly: false,
    destroyRace: null,
    transforms: false,
    grantsTaunt: false,
    untargeted: false,
    givesMinion: false,
    branches: [],
    chosen: null,
  };
  return spellTargetOn(buff, state, deps, rules)?.target ?? null;
}

/**
 * Что сказать о ветвях модального заклинания: поле совета и слова причины.
 *
 * Одно место на руку и на витрину — совет об одном и том же заклинании
 * не имеет права звучать по-разному оттого, где оно лежит.
 */
function branchAdvice(effect: SpellEffect): {
  readonly branches: readonly SpellBranch[];
  readonly note: string;
} {
  const label = (b: SpellBranch): string => (b.label === '' ? b.name : `${b.name} ${b.label}`);
  if (effect.branches.length === 0) return { branches: [], note: '' };

  const chosen = effect.chosen === null ? undefined : effect.branches[effect.chosen];
  if (chosen !== undefined) return { branches: [chosen], note: `ветвь ${label(chosen)}` };

  // «Наша шкала не разделяет» — единственная формулировка, верная в обоих
  // случаях: и когда ветви стоят поровну (Alliance Flag: +3/+1 против
  // +1/+3), и когда одну из них оценить нечем (Boundless Potential:
  // миньон против заклинания таверны). Писать «равны» во втором случае
  // было бы неправдой.
  return {
    branches: effect.branches,
    note: `ветви ${effect.branches.map(label).join(' и ')} наша шкала не разделяет`,
  };
}

/**
 * Правила розыгрыша заклинаний из руки.
 *
 * Бой заклинания не играет, но забытая в руке монетка — потерянное золото,
 * а неразыгранный бафф — потерянные статы ближайшего боя (part10, ход 9:
 * бесплатная Тавматургия +1/+1 лежала в руке при совете «НИЧЕГО»).
 *
 * Два случая, оба читаются из опубликованного текста и тегов:
 *
 * - **экономическое** («Gain N Gold»): советуется, только когда добавка
 *   открывает действие, которое сейчас не по карману, — покупку или подъём.
 *   Иначе монетка честно копится (part10, ход 9: золото 0, монетка молчит);
 * - **усиление** («+X/+Y», «+{0} Attack», щит): советуется, когда по карману;
 *   цель — самый крупный свой миньон, очки — те же веса статов и щита,
 *   что у миньонов. Точечный выбор цели правила не судят — сказано в docs.
 */
export function spellRules(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation[] {
  return state.handSpells.flatMap((spell) => {
    if (spell.unplayable) return [];
    const effect = spellEffect(spell.cardId, spell.scriptData, deps.cards, rules);
    if (effect === null) return [];
    const name = deps.cards.info(spell.cardId)?.name ?? spell.cardId;

    if (effect.gold > 0) {
      const net = effect.gold - spell.cost;
      if (net <= 0) return [];
      const richer = { ...state, gold: state.gold + net };

      // Покупка, которая откроется: сейчас золота не хватает, с монеткой — да.
      if (state.gold < rules.minionCost && richer.gold >= rules.minionCost) {
        const unlocked = buyRules(richer, deps, rules);
        const best = unlocked.reduce(
          (a: Recommendation | null, b) => (a === null || b.score > a.score ? b : a),
          null,
        );
        if (best?.minion != null) {
          const bestName = deps.cards.info(best.minion.cardId)?.name ?? best.minion.cardId;
          return [
            {
              action: 'play' as const,
              minion: null,
              spellCardId: spell.cardId,
              score: best.score,
              cost: spell.cost,
              requiresSlot: false,
              sellFirst: null,
              reason:
                `${name} даёт ${String(net)} золота — откроется покупка ` +
                `${bestName} (${best.score.toFixed(1)})`,
            },
          ];
        }
      }

      // Подъём таверны, до которого не хватает ровно этой добавки.
      const upgrade = state.tavernUpgradeCost;
      if (upgrade !== null && state.gold < upgrade && richer.gold >= upgrade) {
        const levelled = levelUpRule(richer, rules, buyRules(richer, deps, rules));
        if (levelled !== null && levelled.score > 0) {
          return [
            {
              action: 'play' as const,
              minion: null,
              spellCardId: spell.cardId,
              score: levelled.score,
              cost: spell.cost,
              requiresSlot: false,
              sellFirst: null,
              reason: `${name} даёт ${String(net)} золота — откроется подъём таверны`,
            },
          ];
        }
      }

      // Ничего не открывается — монетка честно копится.
      return [];
    }

    // Усиление или замена: бесплатная ценность перед боем.
    if (spell.cost > state.gold || state.board.length === 0) return [];
    const score =
      (effect.transforms
        ? rules.value.transform
        : effect.stats * rules.value.perStatPoint +
          (effect.divineShield ? rules.value.divineShield : 0) +
          (effect.grantsTaunt ? rules.value.taunt : 0)) -
      spell.cost * rules.goldPointValue;
    if (score <= 0) return [];

    const aimed = spellTargetOn(effect, state, deps, rules, spell.cardId);
    if (aimed === null) return [];
    const branch = branchAdvice(effect);

    return [
      {
        action: 'play' as const,
        minion: null,
        spellCardId: spell.cardId,
        spendsMagnetCharge: aimed.spendsCharge ?? false,
        targetMinion: aimed.target,
        spellBranches: branch.branches,
        score,
        cost: spell.cost,
        requiresSlot: false,
        sellFirst: null,
        reason:
          `${name} — ${effect.transforms ? 'замена' : 'усиление перед боем'}` +
          (effect.stats > 0 ? ` (+${String(effect.stats)} статов)` : '') +
          (effect.divineShield ? ' и щит' : '') +
          (branch.note === '' ? '' : `, ${branch.note}`) +
          `, ${aimed.note}`,
      },
    ];
  });
}

/**
 * Правила покупки заклинаний из витрины.
 *
 * У заклинания витрины, в отличие от миньона, цена в логе есть — тег COST
 * (part11: монетка у бармена за 1). Оцениваются те же два случая, что
 * у заклинаний руки: золото и усиление; про остальное совет молчит.
 * Золотое заклинание с чистой прибылью — покупка без раздумий; в ноль
 * (монетка за 1 даёт 1) — маленький банк на будущее, советуется последним.
 */
export function shopSpellRules(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation[] {
  return state.shopSpells.flatMap((spell) => {
    if (spell.unplayable || spell.cost > state.gold) return [];
    const effect = spellEffect(spell.cardId, spell.scriptData, deps.cards, rules);
    if (effect === null) return [];
    const name = deps.cards.info(spell.cardId)?.name ?? spell.cardId;

    if (effect.gold > 0) {
      const net = effect.gold - spell.cost;
      if (net < 0) return [];
      const score = net > 0 ? net * rules.goldPointValue : 0.5;
      return [
        {
          action: 'buy' as const,
          minion: null,
          spellCardId: spell.cardId,
          score,
          cost: spell.cost,
          requiresSlot: false,
          sellFirst: null,
          reason:
            net > 0
              ? `${name} за ${String(spell.cost)} даёт ${String(effect.gold)} золота — чистая прибыль`
              : `${name} за ${String(spell.cost)} — золото про запас, потратится в нужный ход`,
        },
      ];
    }

    // Заклинание, дающее миньона, — это покупка дешевле трёх золота, и оно
    // сравнимо с покупками напрямую: та же шкала, что у силы героя (part17,
    // ход 1: Enchanted Lasso за 2 при витрине из двух миньонов). Пустой
    // борд ему не помеха — миньон и есть его наполнение.
    if (effect.givesMinion) {
      const { score, average, discounted } = givesMinionValue(state, deps, rules, spell.cost, true);
      const cheaper = rules.minionCost - spell.cost;
      // Модальное «даёт миньона» (The Road Less Traveled, Boundless
      // Potential) спросит игрока сразу после покупки — ветви называются
      // и здесь, а не только у усилений.
      const branch = branchAdvice(effect);
      return [
        {
          action: 'buy' as const,
          minion: null,
          spellCardId: spell.cardId,
          spellBranches: branch.branches,
          score,
          cost: spell.cost,
          requiresSlot: false,
          sellFirst: null,
          reason:
            `${name} за ${String(spell.cost)} даёт миньона — как средний из витрины ` +
            `(${average.toFixed(1)})` +
            (discounted && cheaper > 0
              ? `, но на ${String(cheaper)} золота дешевле покупки`
              : ', и это дешёвое тело, а не лучшее') +
            (branch.note === '' ? '' : `; ${branch.note}`),
        },
      ];
    }

    if (state.board.length === 0) return [];
    const score = effect.transforms
      ? rules.value.transform
      : effect.stats * rules.value.perStatPoint +
        (effect.divineShield ? rules.value.divineShield : 0) +
        (effect.grantsTaunt ? rules.value.taunt : 0);
    if (score <= 0) return [];
    const aimed = spellTargetOn(effect, state, deps, rules, spell.cardId);
    if (aimed === null) return [];
    const branch = branchAdvice(effect);
    return [
      {
        action: 'buy' as const,
        minion: null,
        spellCardId: spell.cardId,
        spendsMagnetCharge: aimed.spendsCharge ?? false,
        targetMinion: aimed.target,
        spellBranches: branch.branches,
        score,
        cost: spell.cost,
        requiresSlot: false,
        sellFirst: null,
        reason:
          `${name} за ${String(spell.cost)} — ${effect.transforms ? 'замена' : 'усиление'}` +
          (effect.stats > 0 ? ` (+${String(effect.stats)} статов)` : '') +
          (effect.divineShield ? ' и щит' : '') +
          (branch.note === '' ? '' : `, ${branch.note}`) +
          `, ${aimed.note}`,
      },
    ];
  });
}

/**
 * Правило тёмного дара.
 *
 * Дар — усиление миньона, которого не купить в витрине; игрок жмёт кнопку
 * и выбирает один дар из трёх. Цена читается из тега COST кнопки, нажатие
 * в этом ходу — из блока PLAY на ней. Совет не ворует золото у подъёма
 * таверны, как и обновление витрины.
 */
export function darkGiftRule(
  state: GameState,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): Recommendation | null {
  const cost = state.darkGiftCost;
  if (cost === null || state.darkGiftUsedThisTurn) return null;
  if (cost > state.gold) return null;
  if (state.board.length === 0) return null;

  // Золото дара уступается подъёму только при настоящем отставании от
  // графика. Первая версия блокировала дар всякий раз, когда подъём был
  // «по карману», — а по карману он при нетронутом золоте почти всегда,
  // и на part8 дар не был посоветован ни разу за партию.
  const behind = targetTier(state.turn, rules) > state.techLevel;
  const upgrade = state.tavernUpgradeCost;
  if (behind && upgrade !== null && state.gold >= upgrade && state.gold - cost < upgrade) {
    return null;
  }

  return {
    action: 'darkGift',
    minion: null,
    score: rules.darkGift.value,
    cost,
    requiresSlot: false,
    sellFirst: null,
    reason: `тёмный дар за ${String(cost)} — усиление миньона, которого не купить в витрине`,
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
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): TrinketAdvice[] {
  const { cards } = deps;
  if (state.trinketOffer.length === 0) return [];
  const stats = bgStatsOf(deps);

  const scored = state.trinketOffer.map((offer) => {
    const info = cards.info(offer.cardId);
    const name = info?.name ?? offer.cardId;
    const text = info?.text ?? '';

    // Племя берётся из двух источников: теги BACON_SUBSET_<RACE> на сущности
    // (надёжнее: у «Разноцветного компаса» племя в тексте — плейсхолдер {0},
    // и текстовый разбор его не видел, part12) и слова текста — для
    // тринкетов без тега.
    const fromText = Object.entries(rules.tribeTextWords)
      .filter(([, word]) => new RegExp(`\\b(?:${word})\\b`, 'i').test(text))
      .map(([race]) => race);
    const tribes = [...new Set([...offer.subsetRaces, ...fromText])];

    const tribeMinions =
      tribes.length === 0
        ? 0
        : state.board.filter((m) => {
            const races = racesOf(m, cards);
            return races.includes(RACE_ALL) || races.some((r) => tribes.includes(r));
          }).length;

    // Сверка с составом партии: свои миньоны племени X обычно доказывают X
    // сами (куплены из витрины), но амальгамы и карты, полученные вне
    // магазина, создают фантомные племена — «Рука-протез» приносит мехов
    // в партию без мехов (part11). Пока состав недонабран, молчание данных
    // не считается отсутствием племени.
    const proven = lobbyRaces(state, cards);
    const unseen =
      proven.size >= rules.lobbyRacesKnownAfter
        ? tribes.filter((t) => !proven.has(t))
        : [];
    const unseenNote =
      unseen.length > 0 ? ` (${unseen.join('/')} в витринах партии не встречалось)` : '';

    // Статистика мест из снапшота Firestone: данные, а не мнение. Особенно
    // ценна там, где прежде было голое «оценить не берёмся».
    const stat = stats?.trinket(offer.cardId) ?? null;
    const statNote =
      stat === null ? '' : `; по статистике место ${stat.averagePlacement.toFixed(2)}`;

    return {
      offer,
      name,
      tribeMinions,
      averagePlacement: stat?.averagePlacement ?? null,
      reason:
        (tribes.length === 0
          ? 'эффект вне племён'
          : tribeMinions === 0
            ? `для племени ${tribes.join('/')}, а своих таких нет${unseenNote}`
            : `упоминает ${tribes.join('/')} — своих ${String(tribeMinions)}${unseenNote}`) +
        (tribes.length === 0 && stat === null ? ' — оценить не берёмся' : statNote),
    };
  });

  // Ранжирование совмещает статистику и синергию. У вариантов со
  // статистикой считается «эффективное место»: среднее место минус
  // trinketPlacePerTribeMinion за каждого своего миньона племени. Так
  // сильный нейтральный обходит слабый племенной — правило JeefHS,
  // подтверждено игроком (docs/jeefhs.md), — а сильная синергия (4+
  // своих) статистикой не перебивается. Варианты без статистики
  // ранжируются прежним порядком: сначала свои племена — глобальное
  // среднее нашего борда не знает.
  const effectivePlace = (t: { averagePlacement?: number | null; tribeMinions: number }) =>
    t.averagePlacement == null
      ? null
      : t.averagePlacement - t.tribeMinions * rules.trinketPlacePerTribeMinion;
  return scored.sort((a, b) => {
    const ea = effectivePlace(a);
    const eb = effectivePlace(b);
    if (ea !== null && eb !== null && ea !== eb) return ea - eb;
    return (
      b.tribeMinions - a.tribeMinions ||
      (a.averagePlacement ?? 9) - (b.averagePlacement ?? 9)
    );
  });
}

/**
 * Напоминание за ход до предложения тринкетов.
 *
 * Предложения открываются на ходах `trinketOfferTurns` (11 и 17 — 6-й
 * и 9-й ходы таверны, замерено по всем партиям билда 248348), и игра
 * подбирает их под борд — тьюторинг из базы знаний JeefHS, подтверждён
 * игроком (docs/jeefhs.md). Напоминание называет племена, у которых
 * уже есть 2+ своих, — их тринкеты и приедут; без таких — предупреждает,
 * что предложение будет случайным.
 *
 * Амальгамы (`ALL`) в счёт не идут: тьюторингу нужен внятный сигнал
 * борда, а амальгама «своя» для всех племён сразу.
 */
export function trinketForecast(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): string | null {
  if (!rules.trinketOfferTurns.includes(state.turn + 2)) return null;

  const counts = new Map<string, number>();
  for (const m of state.board) {
    for (const race of racesOf(m, deps.cards)) {
      if (race === RACE_ALL) continue;
      counts.set(race, (counts.get(race) ?? 0) + 1);
    }
  }
  const strong = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([race, n]) => `${race} ×${String(n)}`);

  return strong.length > 0
    ? `следующим ходом — выбор тринкета; предложение подбирается под борд, ` +
        `своих 2+: ${strong.join(', ')}`
    : 'следующим ходом — выбор тринкета; предложение подбирается под борд, ' +
        'а племени с 2+ своими нет — держите пару миньонов желаемого племени';
}

/** Один вариант открытого выбора «возьмите одно из» с оценкой. */
export interface ChoiceAdvice {
  readonly option: ChoiceOption;
  readonly name: string;
  /** Оценка той же функцией, что у витрины. `null` у не-миньонов. */
  readonly value: ValueBreakdown | null;
  /**
   * Очки для ранжирования: у миньонов — `value.total`, у заклинаний —
   * оценка эффекта из текста. `null` — оценить не взялись.
   */
  readonly score: number | null;
  readonly reason: string;
}

/**
 * Совет по открытому выбору: награда за тройку, раскопка карт, сокровища.
 *
 * Варианты-миньоны оцениваются той же функцией, что и витрина, — тир, статы,
 * племя, копии. Именно здесь копии решают: выбор, собирающий тройку, стоит
 * выше любых статов. Варианты-заклинания оцениваются эффектом из текста
 * (усиление, щит, золото) — так выбор сокровищ part10 («+{0} Attack and
 * Divine Shield» против бананов) получает рекомендацию, а не молчание.
 * Что не разобралось, честно помечено «оценить не берёмся».
 *
 * Тринкеты сюда не попадают: их выбор идёт отдельным полем `trinkets`
 * со своим ранжированием по племенам из текста.
 */
export function choiceAdvice(
  state: GameState,
  deps: TavernAdvisorDeps,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): ChoiceAdvice[] {
  const choice = state.openChoice;
  if (choice === null || choice.options.length === 0) return [];

  const scored = choice.options.map((option) => {
    const info = deps.cards.info(option.cardId);
    const name = info?.name ?? option.cardId;

    if (info === null || info.type !== 'MINION') {
      // Заклинание: оценка эффекта из текста и тегов варианта.
      const effect =
        info !== null && (info.type?.includes('SPELL') ?? false)
          ? spellEffect(option.cardId, option.scriptData ?? [], deps.cards, rules)
          : null;
      if (effect === null || (effect.stats === 0 && !effect.divineShield && effect.gold === 0)) {
        return { option, name, value: null, score: null, reason: 'оценить не берёмся' };
      }
      const score =
        effect.stats * rules.value.perStatPoint +
        (effect.divineShield ? rules.value.divineShield : 0) +
        effect.gold * rules.goldPointValue;
      const parts = [
        effect.stats > 0 ? `+${String(effect.stats)} статов` : '',
        effect.divineShield ? 'щит' : '',
        effect.gold > 0 ? `${String(effect.gold)} золота` : '',
      ].filter((p) => p !== '');
      return {
        option,
        name,
        value: null,
        score,
        reason: `заклинание: ${parts.join(', ')} — очки ${score.toFixed(1)}`,
      };
    }

    // Псевдо-миньон из справочника: у варианта выбора нет сущности с тегами,
    // есть только карта. Ключевые слова (щит, яд) при этом не видны —
    // тир, статы, племя и копии дают основную часть различий.
    const candidate: Minion = {
      entityId: option.entityId,
      cardId: option.cardId,
      zonePos: 0,
      attack: info.attack,
      health: info.health,
      taunt: false,
      divineShield: false,
      poisonous: false,
      venomous: false,
      reborn: false,
      windfury: false,
      stealth: false,
      golden: false,
      frozen: false,
      maxHealth: info.health,
      techLevel: info.techLevel,
      enchantments: [],
      scriptData: [],
      tags: {},
    };
    const value = minionValue(candidate, state, deps, rules);

    const notes: string[] = [];
    if (value.copiesOwned >= 2) notes.push('собирает тройку');
    else if (value.copiesOwned === 1) notes.push('вторая копия');
    if (value.tribeMates > 0) notes.push(`своих по племени ${String(value.tribeMates)}`);
    if (value.textTribeMates > 0) {
      notes.push(`племя из текста: своих ${String(value.textTribeMates)}`);
    }
    if (value.doubler > 0) notes.push('свой удвоитель на борде — триггер принесёт вдвое');
    if (info.magnetic) notes.push('магнитный');

    return {
      option,
      name,
      value,
      score: value.total,
      reason:
        `тир ${info.techLevel === null ? '?' : String(info.techLevel)}, ` +
        `ценность ${value.total.toFixed(1)}` +
        (notes.length > 0 ? ` — ${notes.join(', ')}` : ''),
    };
  });

  // По убыванию очков; неоценённое — в конце в исходном порядке.
  return scored.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

/** Шаг плана розыгрыша. */
export interface PlanStep {
  readonly minion: Minion;
  /** К кому примагнитить; `null` — поставить в свободный слот. */
  readonly magnetizeTo: Minion | null;
  /** Кого продать ради места. Не больше одного такого шага на план. */
  readonly sellFirst: Minion | null;
  readonly score: number;
}

/**
 * План розыгрыша, когда разыграть стоит несколько карт за ход.
 *
 * Отдельные советы «разыграть X» этого не выражают: игрок читает верхнюю
 * строку и ставит одну карту, хотя мог разыграть больше (part9, ход 25 —
 * на борде одно место, а в руке Glambot, Kangor's Apprentice и магнитный
 * Accord-o-Tron). План раскладывает розыгрыши по слотам сам: обычные миньоны
 * по убыванию ценности занимают свободные места, магнитные примагничиваются
 * и мест не тратят. Порядок в плане — сначала тела, потом магниты: свежий
 * мех тоже кандидат в носители.
 */
export function playPlan(
  state: GameState,
  deps: TavernAdvisorDeps,
  plays: readonly Recommendation[],
  rules: TavernRules = DEFAULT_TAVERN_RULES,
): PlanStep[] {
  const candidates = [...plays]
    .filter((r) => r.action === 'play' && r.minion !== null)
    .sort((a, b) => b.score - a.score);
  if (candidates.length < 2) return [];

  let slots = Math.max(0, rules.boardSize - state.board.length);
  const boardAfter: Minion[] = [...state.board];
  const bodies: PlanStep[] = [];
  const magnets: { rec: Recommendation; minion: Minion }[] = [];
  // Розыгрыш через продажу в плане один: жертву каждый совет считал против
  // исходного борда, и второй такой шаг продавал бы того же миньона дважды.
  let displaced = false;

  for (const rec of candidates) {
    const minion = rec.minion;
    if (minion === null) continue;
    if (isMagnetic(minion, deps.cards)) {
      magnets.push({ rec, minion });
      continue;
    }
    if (slots > 0) {
      slots -= 1;
      boardAfter.push(minion);
      bodies.push({ minion, magnetizeTo: null, sellFirst: null, score: rec.score });
      continue;
    }
    if (rec.sellFirst !== null && !displaced) {
      displaced = true;
      boardAfter.push(minion);
      bodies.push({ minion, magnetizeTo: null, sellFirst: rec.sellFirst, score: rec.score });
    }
  }

  // Магниты после тел: только что разыгранный мех — тоже кандидат в носители.
  const magnetSteps: PlanStep[] = [];
  const poison = poisonAmongSeen(state);
  for (const { rec, minion } of magnets) {
    const host = magnetizeTarget(
      minion,
      boardAfter.filter((m) => m.entityId !== minion.entityId),
      deps.cards,
      poison,
    );
    if (host !== null) {
      magnetSteps.push({ minion, magnetizeTo: host, sellFirst: null, score: rec.score });
    } else if (slots > 0) {
      slots -= 1;
      boardAfter.push(minion);
      magnetSteps.push({ minion, magnetizeTo: null, sellFirst: null, score: rec.score });
    }
  }

  const steps = [...bodies, ...magnetSteps];
  return steps.length >= 2 ? steps : [];
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
  if (state.phase !== 'tavern') return null;

  // До выбора героя советовать нечего, КРОМЕ самого выбора героя: он идёт
  // тем же каналом выборов, и его ранжирует статистика мест.
  if (state.hero === null) {
    if (state.heroChoice === null) return null;
    return {
      recommendations: [],
      gold: state.gold,
      targetTier: targetTier(state.turn, rules),
      shopValues: [],
      trinkets: [],
      choice: [],
      playPlan: [],
      heroChoice: heroChoiceAdvice(state, deps),
      trinketForecast: null,
    };
  }

  const buys = buyRules(state, deps, rules);
  const plays = playRules(state, deps, rules);
  const recommendations: Recommendation[] = [
    ...buys,
    ...plays,
    ...spellRules(state, deps, rules),
    ...shopSpellRules(state, deps, rules),
    levelUpRule(state, rules, buys),
    heroPowerRule(state, deps, rules),
    freeHeroPowerRule(state, deps, rules),
    heroPowerSpellRule(state, deps, rules),
    ...activationRules(state, deps, rules),
    darkGiftRule(state, rules),
    spinRule(state, deps, rules, buys),
    sellRule(state, deps, rules),
    sellForGoldRule(state, deps, rules),
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

  const sorted = recommendations.sort((a, b) => b.score - a.score);

  // «Делать нечего, а золото есть»: когда лучший совет — «ничего», а на
  // обновление витрины хватает, обновление и есть ход — поиск лучшего.
  // Случай part11: борд полон и силён, все покупки отсеяны, 5 золота,
  // совет «НИЧЕГО» — игрок справедливо заметил, что мог обновляться.
  const idleRerollCost = rerollCostOf(state, rules);
  if (
    sorted[0]?.action === 'pass' &&
    state.gold >= idleRerollCost &&
    // «Делать нечего» с золотом на покупку — повод искать; с золотом
    // на один реролл в ранней партии — нет (part18, ход 7).
    paidRerollIsUseful(state, rules) &&
    state.shop.some((m) => !m.frozen)
  ) {
    sorted.unshift({
      action: 'reroll',
      minion: null,
      score: 0.5,
      cost: idleRerollCost,
      requiresSlot: false,
      sellFirst: null,
      reason:
        idleRerollCost === 0
          ? 'покупать нечего и некуда, а обновление бесплатно — искать лучшее'
          : `покупать нечего и некуда, а золота ${String(state.gold)} — ` +
            'обновление витрины в поиске лучшего',
    });
  }

  return {
    recommendations: sorted,
    gold: state.gold,
    targetTier: targetTier(state.turn, rules),
    shopValues: state.shop.map((minion) => ({
      minion,
      value: minionValue(minion, state, deps, rules),
    })),
    trinkets: trinketAdvice(state, deps, rules),
    choice: choiceAdvice(state, deps, rules),
    playPlan: playPlan(state, deps, plays, rules),
    heroChoice: heroChoiceAdvice(state, deps),
    trinketForecast: trinketForecast(state, deps, rules),
  };
}
