import { buyCostOf, heroPowerReady, tripleMergeOf } from '../advisors/tavern/advisor.js';
import type { CardIndex } from '../data/cards.js';
import type { GameState, Minion, PlayerAction } from '../state/types.js';
import { idleBeforeEnd, turnSeconds, type ReportTurn, type TurnMoment } from './timeline.js';
import type { Finding } from './types.js';
import { clicks, freeSlots } from './words.js';

/**
 * Пункты отчёта, видные из лога без симулятора и без советника.
 *
 * Факт — правило игры, а не мнение: «ошибка ли» решается тем, что игрок
 * видел в момент хода. Где у игрока была законная причина поступить
 * иначе (подъём, заморозка, место под призыв) или где он мог не успеть
 * увидеть (витрина мелькнула на секунды), пункт уходит в предположения
 * с причиной. Всё, что зависит от советника или от борда соперника,
 * — в `assumptions.ts` и `battle.ts`.
 *
 * Частоты по разведке 25.09.2026 (30 партий part44–part73, 383 хода
 * таверны): третья копия по карману и не взята — 2 окна из 51, одно
 * из них — размен на темп (part49); золото при доступной покупке сгорело
 * в 10 ходах; бесплатная сила «только прибавляет» не нажата — 3. Пустой
 * раздел фактов у большинства партий — ожидаемый ответ, а не поломка.
 */

/**
 * «Последнее действие за N с до конца хода» — порог строки ленты, с.
 *
 * Объявлен до прогона (D088) и НЕ значит «ход съеден таймером»: у трети
 * ходов последнее нажатие — перестановка своего борда, в том числе у 7
 * из 26 ходов с паузой ≤ 5 с (критик, part60–75). Однозначный признак
 * обрыва — неисполненное нажатие (`TurnClock.lastClickUnanswered`).
 */
export const LATE_ACTION_SECONDS = 5;

/**
 * Меньше скольких секунд витрина с третьей копией была на экране, чтобы
 * пункт не считался фактом: в цепочке обновлений витрина живёт 1.5–3 с,
 * и третью копию игрок мог физически не разглядеть (27 из 42 обновлений
 * подряд в part68, part72–75 шли быстрее трёх секунд). Объявлен до прогона.
 */
export const TRIPLE_EXPOSURE_SECONDS = 3;

/** Карт в руке не бывает больше — правило игры. */
export const HAND_LIMIT = 10;
export const BOARD_LIMIT = 7;

/**
 * Силы, нажатие которых никогда не вредит: бесплатные и только
 * прибавляющие. Список ручной и закрытый — сила вне списка фактом
 * не становится, сколько бы раз её ни пропустили: у «Once per game»
 * сбережение — стратегия (D191), у платной при нуле золота выбора нет.
 * Цена у обеих в логе не пишется вовсе (`heroPowerCost` = null).
 *
 *  - `BG20_HERO_201p` Spirit Swap (Vol'jin): «They gain each other's
 *    Attack until next turn» — жмётся каждый ход (D240);
 *  - `BG26_HERO_102p2` Minor Hymn (Inge): «Twice per turn, give a minion
 *    Health equal to your Tier» (D187).
 */
export const FREE_ADDING_POWERS: ReadonlySet<string> = new Set(['BG20_HERO_201p', 'BG26_HERO_102p2']);

/**
 * Чем карта награждает или переносит НЕистраченное золото — при ней остаток
 * не ошибка: Tavern Tipper (`BG23_352`), Timewarped Tipper (`BG34_Giant_604`),
 * аномалия Prudence of Amitus (`BG27_Anomaly_002`, «Unspent Gold carries over
 * to your next turn»), квест `BG24_Quest_351`. Читается текстом по борду,
 * руке, силе, аномалии и тринкетам — так ловятся и золотые версии.
 */
const UNSPENT_GOLD_WORDS = /\bunspent\s+gold\b/i;

/**
 * Карта, чья ценность — лежать в руке («While this is in your hand…»,
 * Bream Counter, part49): пустой слот при ней — не забытый розыгрыш.
 */
const HAND_EFFECT_WORDS = /\b(?:in|from)\s+your\s+hand\b/i;

/**
 * Призыв в бою на свободное место — тогда пустой слот бывает стратегией:
 * Broodmother Ониксии («Avenge (4): Summon a Whelp»), Frostwolf Fervor
 * у Drek'Thar («When you have space in combat, summon…»).
 */
const SUMMON_INTO_SPACE = /\bspace\b[^.]*\bsummon|\bsummon[^.]*\bspace\b|\bavenge\b[^.]*\bsummon/i;

const clockOf = (time: string): string => time.slice(0, 8);

function nameOf(cards: CardIndex, cardId: string): string {
  return cards.info(cardId)?.name ?? cardId;
}

function handCount(state: GameState): number {
  return state.hand.length + state.handSpells.length;
}

/** Тексты всего, что у игрока действует постоянно: борд, рука, сила, аномалия, тринкеты. */
function standingTexts(state: GameState, cards: CardIndex): string[] {
  const ids = [
    ...state.board.map((m) => m.cardId),
    ...state.hand.map((m) => m.cardId),
    state.hero?.heroPowerCardId ?? null,
    state.anomalyCardId,
  ].filter((id): id is string => id !== null);
  const trinkets = state.playerId === null ? [] : (state.trinketsByPlayer[state.playerId] ?? []);
  return [
    ...ids.map((id) => cards.info(id)?.text ?? ''),
    ...trinkets.map((dbfId) => cards.infoByDbfId(dbfId)?.text ?? ''),
  ];
}

/** Миньон витрины, которого можно купить ЗОЛОТОМ (не здоровьем, part65). */
function buyableForGold(m: Minion, gold: number): boolean {
  if ((m.tags['BACON_COSTS_HEALTH_TO_BUY'] ?? 0) === 1) return false;
  return buyCostOf(m) <= gold;
}

/** Ход оборвал таймер: последнее нажатие так и не исполнилось. */
export function cutByTimer(turn: ReportTurn): boolean {
  return turn.clock.lastClickUnanswered;
}

/** Последнее действие — в последние `LATE_ACTION_SECONDS` хода. */
export function lateLastAction(turn: ReportTurn): boolean {
  const idle = idleBeforeEnd(turn.clock);
  return idle !== null && idle <= LATE_ACTION_SECONDS;
}

/** Строка про время хода — у каждого пункта: время и есть частая причина. */
export function timerLine(turn: ReportTurn): string {
  const idle = idleBeforeEnd(turn.clock);
  const pressed = clicks(turn.clock.clicks);
  const length = turnSeconds(turn.clock);
  const had = length === null ? '' : `, на ход было ${length.toFixed(0)} с без показа боя`;
  if (idle === null) return `нажатий за ход не было${had}`;
  if (cutByTimer(turn)) return `последнее нажатие не успело исполниться — ход оборвал таймер (${pressed}${had})`;
  return idle <= LATE_ACTION_SECONDS
    ? `последнее действие за ${idle.toFixed(1)} с до конца хода (${pressed}${had})`
    : `до конца хода оставалось ${idle.toFixed(1)} с после последнего действия (${pressed}${had})`;
}

interface FactContext {
  readonly cards: CardIndex;
  /** Журнал действий всей партии — из финального состояния. */
  readonly actions: readonly PlayerAction[];
}

const skeleton = (turn: ReportTurn): Pick<Finding, 'turn' | 'tavernTurn' | 'nextBattle' | 'impact'> => ({
  turn: turn.turn,
  tavernTurn: turn.tavernTurn,
  nextBattle: null,
  impact: null,
});

// ─── третья копия в витрине ──────────────────────────────────────────

interface TripleWindow {
  /** Первый момент, где тройка была по карману. */
  readonly first: TurnMoment;
  readonly minion: Minion;
  readonly copies: number;
  /** Сколько секунд витрина с этой картой простояла на экране при деньгах. */
  readonly exposure: number;
}

/**
 * Окна хода: карта витрины по карману, покупка которой СОБИРАЕТ золотого.
 *
 * Сливает ли покупка тройку — решает правило советника `tripleMergeOf`:
 * оно знает двухкопийных героев и аномалии (Double Time, False Idols)
 * и джокеров тройки (Elemental of Surprise, D268). Свой подсчёт копий
 * тут разошёлся бы с ним молча.
 *
 * Экспозиция — от действия, после которого витрина стала такой (момент
 * перед ним — предыдущий снимок), до последнего момента, где окно ещё
 * открыто, или до конца хода.
 */
function tripleWindows(turn: ReportTurn, cards: CardIndex): TripleWindow[] {
  const moments: TurnMoment[] = [
    ...turn.moments,
    { time: turn.endTime, at: turn.clock.mainEndAt ?? 0, state: turn.end },
  ];
  const start = Math.max(turn.clock.startAt ?? 0, turn.clock.replayEndAt ?? 0);
  const open = new Map<number, { first: TurnMoment; shownAt: number; lastAt: number; minion: Minion; copies: number }>();
  moments.forEach((moment, i) => {
    const { state } = moment;
    if (state.altTavern || handCount(state) >= HAND_LIMIT) return;
    for (const m of state.shop) {
      if (!buyableForGold(m, state.gold)) continue;
      const known = open.get(m.entityId);
      if (known !== undefined) {
        known.lastAt = moment.at;
        continue;
      }
      const merge = tripleMergeOf(m, state, cards);
      if (merge === null) continue;
      const shownAt = i === 0 ? start : (moments[i - 1]?.at ?? start);
      open.set(m.entityId, { first: moment, shownAt, lastAt: moment.at, minion: m, copies: merge.consumed.length });
    }
  });
  return [...open.values()].map((w) => ({
    first: w.first,
    minion: w.minion,
    copies: w.copies,
    exposure: Math.max(0, w.lastAt - w.shownAt),
  }));
}

/**
 * Собрана ли тройка всё-таки: золотая копия этой карты появилась на борде
 * или в руке к концу этого или следующего хода, или куплена та же
 * сущность (с замороженной витрины). По журналу «buy той же карты» судить
 * нельзя — соседняя покупка другой копии совпадает случайно (разведка
 * по part73: мнимое «куплено на ходу 27»).
 */
function tripleTaken(window: TripleWindow, turn: ReportTurn, next: ReportTurn | undefined, ctx: FactContext): boolean {
  if (ctx.actions.some((a) => a.type === 'buy' && a.entityId === window.minion.entityId)) return true;
  const name = nameOf(ctx.cards, window.minion.cardId);
  const golden = (s: GameState | undefined): boolean =>
    s !== undefined && [...s.board, ...s.hand].some((m) => m.golden && nameOf(ctx.cards, m.cardId) === name);
  return golden(turn.end) || golden(next?.end);
}

export function missedTriples(turns: readonly ReportTurn[], ctx: FactContext): Finding[] {
  const out: Finding[] = [];
  turns.forEach((turn, i) => {
    const next = turns[i + 1];
    const seenCards = new Set<string>();
    for (const w of tripleWindows(turn, ctx.cards)) {
      if (seenCards.has(w.minion.cardId) || tripleTaken(w, turn, next, ctx)) continue;
      seenCards.add(w.minion.cardId);
      const name = nameOf(ctx.cards, w.minion.cardId);
      const { state } = w.first;
      const drag = turn.drags.find((d) => d.entityId === w.minion.entityId);
      const froze = ctx.actions.some((a) => a.turn === turn.turn && a.type === 'freeze');
      const frozenWithIt = froze && turn.end.shop.some((m) => m.entityId === w.minion.entityId);

      // Причины не считать это однозначной ошибкой — каждая из фактуры.
      const caveats: string[] = [];
      // Золото ушло на подъём после того, как тройка лежала в витрине:
      // «тройка или темп», а темп прибор не судит (D166, D193) — part49,
      // Millhouse; Изера, сессия 25.09 00:03, ход таверны 4.
      if (turn.end.techLevel > state.techLevel) {
        caveats.push(
          `После этого в том же ходу вы подняли таверну до ${String(turn.end.techLevel)}: тройка против темпа — выбор, который прибор не судит.`,
        );
      }
      if (frozenWithIt) {
        caveats.push('Витрина с этой картой заморожена: тройку откладывали на следующий ход, а ценность заморозки прибор не видит (D274).');
      }
      if (w.exposure < TRIPLE_EXPOSURE_SECONDS && drag === undefined) {
        caveats.push(
          `Витрина с третьей копией была на экране ${w.exposure.toFixed(1)} с — меньше ${String(TRIPLE_EXPOSURE_SECONDS)} с, могли не разглядеть.`,
        );
      }

      const details = [
        `золото ${String(state.gold)}/${String(state.goldTotal)}, в руке ${String(handCount(state))} из ${String(HAND_LIMIT)}; витрина с ней простояла ${w.exposure.toFixed(0)} с`,
        drag === undefined
          ? 'карту не брали'
          : `в ${clockOf(drag.time)} вы взяли эту карту и отпустили обратно в витрину`,
        'золотой этой карты не появился ни к концу этого хода, ни к концу следующего',
        timerLine(turn),
      ];
      out.push({
        ...skeleton(turn),
        kind: caveats.length === 0 ? 'fact' : 'assumption',
        klass: 'missedTriple',
        time: clockOf(w.first.time),
        title: `Третья копия ${name} была в витрине за ${String(buyCostOf(w.minion))} и не взята (${String(w.copies)} на столе и в руке)`,
        details,
        impactNote:
          'Пересчёт боя не делается: награда за тройку — раскрытие карты, и чем бы оно кончилось, неизвестно.',
        caveats,
      });
    }
  });
  return out;
}

// ─── сгоревшее золото ────────────────────────────────────────────────

/** Миньоны витрины, которые на конце хода можно было купить золотом. */
export function affordableShop(state: GameState): Minion[] {
  return state.shop.filter((m) => buyableForGold(m, state.gold));
}

export function burnedGold(turns: readonly ReportTurn[], ctx: FactContext, gameOver: boolean): Finding[] {
  const out: Finding[] = [];
  const last = turns.at(-1)?.turn;
  for (const turn of turns) {
    const s = turn.end;
    if (s.gold < 1 || s.altTavern || handCount(s) >= HAND_LIMIT) continue;
    const options = affordableShop(s);
    if (options.length === 0) continue;
    // Остаток, который что-то даёт или переносится, — не потеря.
    if (standingTexts(s, ctx.cards).some((text) => UNSPENT_GOLD_WORDS.test(text))) continue;
    const cheapest = Math.min(...options.map((m) => buyCostOf(m)));
    const details = [
      `в витрине по карману: ${options.map((m) => `${nameOf(ctx.cards, m.cardId)} за ${String(buyCostOf(m))}`).join(', ')}`,
      `самая дешёвая покупка — ${String(cheapest)}, рука ${String(handCount(s))} из ${String(HAND_LIMIT)}, борд ${String(s.board.length)} из ${String(BOARD_LIMIT)}`,
      timerLine(turn),
    ];
    if (gameOver && turn.turn === last) details.push('это последний ход партии');
    out.push({
      ...skeleton(turn),
      kind: 'fact',
      klass: 'burnedGold',
      time: clockOf(turn.endTime),
      title: `Сгорело ${String(s.gold)} золота при доступной покупке`,
      details,
      impactNote: null,
      caveats: [],
    });
  }
  return out;
}

// ─── бесплатная сила ─────────────────────────────────────────────────

export function idlePowers(turns: readonly ReportTurn[], ctx: FactContext): Finding[] {
  const out: Finding[] = [];
  for (const turn of turns) {
    const hero = turn.end.hero;
    if (hero === null || hero.heroPowerCardId === null) continue;
    if (!FREE_ADDING_POWERS.has(hero.heroPowerCardId)) continue;
    if ((hero.heroPowerCost ?? 0) !== 0 || !heroPowerReady(hero)) continue;
    const pressed = ctx.actions.filter((a) => a.turn === turn.turn && a.type === 'heroPower').length;
    const name = nameOf(ctx.cards, hero.heroPowerCardId);
    out.push({
      ...skeleton(turn),
      kind: 'fact',
      klass: 'idlePower',
      time: clockOf(turn.endTime),
      title:
        pressed === 0
          ? `Бесплатная сила ${name} не нажата`
          : `Бесплатная сила ${name} нажата ${String(pressed)} раз, осталось ещё нажатие`,
      details: ['сила ничего не стоит и только прибавляет — нажатие не вредит никогда', timerLine(turn)],
      impactNote: 'Пересчёт боя не делается: кому досталась бы прибавка, выбирает игрок.',
      caveats: [],
    });
  }
  return out;
}

// ─── миньон в руке при свободном месте ───────────────────────────────

/**
 * Миньоны руки на конце хода, которых нечем объяснить держать в руке.
 *
 * Считаются только те, что лежали в руке хотя бы за `LATE_ACTION_SECONDS`
 * до конца хода: карта из раскопки, пришедшая в последнюю секунду,
 * поставлена быть не могла (part61, ход 19: Turquoise Skitterer лёг
 * в руку в 00:01:21.3425451 — той же меткой, что `MAIN_END`,
 * game.log:191555 и :191613).
 */
export function unplacedMinions(turn: ReportTurn, cards: CardIndex): Minion[] {
  const state = turn.end;
  const cutoff = (turn.clock.mainEndAt ?? Number.POSITIVE_INFINITY) - LATE_ACTION_SECONDS;
  const early = [...turn.moments].reverse().find((m) => m.at <= cutoff);
  const held = new Set(early?.state.hand.map((m) => m.entityId) ?? []);
  const pool = [...state.board, ...state.hand];
  return state.hand.filter((m) => {
    if (!held.has(m.entityId)) return false;
    if ((m.tags['LITERALLY_UNPLAYABLE'] ?? 0) === 1) return false;
    // Копия под тройку — ставка, розыгрыш её не улучшает (D015).
    if (!m.golden && pool.filter((x) => !x.golden && x.cardId === m.cardId).length >= 2) return false;
    return !HAND_EFFECT_WORDS.test(cards.info(m.cardId)?.text ?? '');
  });
}

/**
 * Слот считается по борду ПЕРЕД боем, а не на `MAIN_END`: у Ониксии
 * дракончик силы занимает место после конца хода (part73, ходы 17/19/21),
 * и такой слот игрок не забывал.
 *
 * Фактом пункт становится, только если ход оборвал таймер (неисполненное
 * нажатие): иначе слот бывал держан намеренно (part73, ход 23: Gatekeeper
 * Amalgam разыгран и продан на следующем ходу) — предположение.
 * При силе или тринкете, призывающих в свободное место, класс молчит.
 */
export function idleSlots(turns: readonly ReportTurn[], ctx: FactContext): Finding[] {
  const out: Finding[] = [];
  for (const turn of turns) {
    const combat = turn.beforeCombat;
    if (combat === null || combat.board.length >= BOARD_LIMIT) continue;
    if (standingTexts(turn.end, ctx.cards).some((text) => SUMMON_INTO_SPACE.test(text))) continue;
    const left = unplacedMinions(turn, ctx.cards);
    if (left.length === 0) continue;
    const names = left.map((m) => nameOf(ctx.cards, m.cardId)).join(', ');
    const free = BOARD_LIMIT - combat.board.length;
    const cut = cutByTimer(turn);
    out.push({
      ...skeleton(turn),
      kind: cut ? 'fact' : 'assumption',
      klass: 'unplacedMinion',
      time: clockOf(turn.endTime),
      title: cut
        ? `Не успел поставить: ${names} — на борде ${freeSlots(free)}`
        : `В руке остался ${names}, а на борде ${freeSlots(free)}`,
      details: [timerLine(turn)],
      impactNote: null,
      caveats: cut
        ? []
        : ['Бывает сознательно: карта под эффект следующего хода, продажа ради золота. Прибор этого не различает.'],
    });
  }
  return out;
}

/**
 * Чего отчёт не судит вовсе — чтобы молчание не читалось как «сыграно
 * чисто». Каждая строка — прибор, которого нет, с решением, где это
 * записано.
 */
export const NOT_JUDGED: readonly { readonly what: string; readonly reason: string }[] = [
  {
    what: 'Подъём таверны и его темп',
    reason: 'ближайший бой подъём не видит по устройству: статов на борд он не кладёт (D193, D166)',
  },
  {
    what: 'Заморозка витрины',
    reason: 'ценность заморозки — на следующем ходу, а приборы через смену хода не смотрят (D274)',
  },
  {
    what: 'Карты, оставленные в руке, и запас бесплатных обновлений',
    reason: 'держать их бывает правильно: запас не сгорает (D244), монета и Leaf ждут покупки (D289, D291)',
  },
  {
    what: 'Выбор тринкета, раскопки, героя',
    reason: 'исход выбора не с чем сравнить: вариантов, которые не взяли, в бою не было',
  },
];
