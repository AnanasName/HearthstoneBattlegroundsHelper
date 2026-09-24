import type { PositionAdvice } from '../advisors/position/advisor.js';
import type { PositionTarget, ResolvedOpponent } from '../advisors/position/opponent.js';
import type {
  ChoiceAdvice,
  PlanStep,
  Recommendation,
  TrinketAdvice,
} from '../advisors/tavern/advisor.js';
import type { BuyCheckResult } from '../advisors/tavern/simulated.js';
import type { SpendPlan } from '../advisors/tavern/spend.js';
import type { CardIndex } from '../data/cards.js';
import type { FieldStrength } from '../advisors/strength/strength.js';
import type { PlaceForecast } from '../ml/forecast.js';
import type { GameState, Minion } from '../state/types.js';

/**
 * Как советы выглядят словами.
 *
 * Одно место на терминал и на оверлей: расходиться им незачем, а решения тут
 * не оформительские. Например, возраст картинки противника — это не украшение
 * подписи, а единственное, что отличает осмысленное число от бессмысленного.
 */

export const ACTION_LABEL: Readonly<Record<Recommendation['action'], string>> = {
  levelUp: 'ПОДНЯТЬ ТАВЕРНУ',
  buy: 'КУПИТЬ',
  play: 'РАЗЫГРАТЬ',
  sell: 'ПРОДАТЬ',
  reroll: 'ОБНОВИТЬ',
  freeze: 'ЗАМОРОЗИТЬ',
  heroPower: 'СИЛА ГЕРОЯ',
  darkGift: 'ТЁМНЫЙ ДАР',
  activate: 'АКТИВИРОВАТЬ',
  spin: 'ПРОКРУТИТЬ',
  pass: 'НИЧЕГО',
};

/** Миньон одной строкой: имя, статы и то, что меняет бой. */
export function minionLabel(m: Minion, cards: CardIndex): string {
  const marks = [
    m.golden ? 'зол' : '',
    m.taunt ? 'провок' : '',
    m.divineShield ? 'щит' : '',
    m.poisonous || m.venomous ? 'яд' : '',
    m.reborn ? 'перерожд' : '',
    m.windfury ? 'вихрь' : '',
  ].filter((x) => x !== '');

  // Заготовка найденного миньона в плане (`isStandIn`, part59): её карта —
  // типичный выбор пула, а не то, что игрок найдёт, и имя с числами
  // читалось бы обещанием. Называется племенем — ровно тем, что известно.
  if (m.entityId < 0) {
    const races = cards.info(m.cardId)?.races ?? [];
    return races.length === 0 ? 'найденного миньона' : `найденного ${races.join('/')}`;
  }

  return (
    `${cards.info(m.cardId)?.name ?? m.cardId} ${String(m.attack ?? '?')}/${String(m.health ?? '?')}` +
    (marks.length > 0 ? ` (${marks.join(',')})` : '')
  );
}

/** Здоровье героя с бронёй, если она есть. */
export function heroHp(state: GameState): string {
  const hero = state.hero;
  if (hero === null) return '?';
  const hp = (hero.health ?? 0) - hero.damage;
  return hero.armor > 0 ? `${String(hp)}+${String(hero.armor)}` : String(hp);
}

export function situationLine(state: GameState): string {
  return (
    `ход ${String(state.turn)} · ${state.phase === 'tavern' ? 'таверна' : 'бой'}` +
    ` · тир ${String(state.techLevel)} · золото ${String(state.gold)}/${String(state.goldTotal)}` +
    ` · hp ${heroHp(state)}`
  );
}

/** Совет по таверне одной строкой. */
export function recommendationLine(r: Recommendation, cards: CardIndex): string {
  const what =
    r.minion !== null
      ? ` ${minionLabel(r.minion, cards)}`
      : r.spellCardId != null
        ? ` ${cards.info(r.spellCardId)?.name ?? r.spellCardId}`
        : '';
  // Активация, забирающая статы следующей покупки, — шаг «нажать, затем
  // купить» (part57): цены у половин свои, и покупка названа словами.
  const then = r.thenBuys ?? null;
  const ownCost = then === null ? r.cost : r.cost - then.cost;
  const price = ownCost > 0 ? ` за ${String(ownCost)}` : '';
  const thenBuy =
    then === null
      ? ''
      : ` → затем ${ACTION_LABEL.buy} ${minionLabel(then.minion, cards)}` +
        (then.cost > 0 ? ` за ${String(then.cost)}` : '');
  const victim = r.sellFirst === null ? '' : `, продав ${minionLabel(r.sellFirst, cards)}`;
  const magnet =
    r.magnetizeTo == null ? '' : `, примагнитив к ${minionLabel(r.magnetizeTo, cards)}`;
  // Цель заклинания-усиления — прямо в строке действия: «РАЗЫГРАТЬ Fortify»
  // без цели перекладывал выбор на игрока (part12).
  const target =
    r.targetMinion == null ? '' : ` → на ${minionLabel(r.targetMinion, cards)}`;
  // Сила-обмен атакой жмётся на ДВУХ миньонов (Вольджин, part56), и второй
  // бывает в витрине — назвать надо обоих.
  const partner = r.sharesAttack?.partner ?? null;
  const pair = partner === null ? '' : ` и ${minionLabel(partner, cards)}`;
  // Ветвь модального «Choose One» — там же и по той же причине: игра
  // спрашивает «Булава или Щит», и совет обязан отвечать (part19).
  // Две ветви в поле означают «равны» — тогда строка называет обе.
  const list = r.spellBranches ?? [];
  const branchLabel = (b: { name: string; label: string }): string =>
    b.label === '' ? b.name : `${b.name} ${b.label}`;
  const branch =
    list.length === 0
      ? ''
      : list.length === 1
        ? ` → ${branchLabel(list[0] as { name: string; label: string })}`
        : ` → ${list.map(branchLabel).join(' либо ')} (выбор за вами)`;
  // Цель обновления — здесь же и по той же причине: у обновления нет ни
  // миньона, ни заклинания, и «ОБНОВИТЬ» в одиночку читается как «покрути
  // просто так». Обновление под цель — это поиск карты ПОД ЗАМОРОЗКУ,
  // то есть покупка следующего хода, и без этих слов возражение игрока
  // «купить всё равно не на что» верно по всему, что он видит (part37).
  const goal = r.searchGoal == null ? '' : ` — ищем ${r.searchGoal}`;
  // Причина ЗАМОРОЗКИ — там же и по тому же доводу, что цель обновления.
  // «ЗАМОРОЗИТЬ Scarlet Skull» при нуле золота игрок прочёл как прихоть
  // (part64), хотя правило держало карту ради двух своих по племени.
  const hold = r.holdReason == null ? '' : ` — ${r.holdReason}`;
  // Витринный бафф «своего типа» спрашивает племя сразу после покупки,
  // и назвать его надо в самой строке: усиление получит ВИТРИНА, а не наш
  // миньон, поэтому «→ на» тут было бы враньём (part43, Eonar's Favor).
  const pick = r.shopBuffPick == null ? '' : ` → выбрать ${r.shopBuffPick}`;
  // Скидка на заклинание витрины от клича — там же и по тому же доводу
  // (part49). Без этих слов план начинается с покупки, которая в списке
  // советов стоит четвёртой: «КУПИТЬ Ominous Seer 2/1 за 2» читается как
  // ошибка, пока не сказано, что следом заклинание стоит на золотой меньше.
  const discount =
    r.spellDiscountAfter === undefined
      ? ''
      : ` — клич: заклинание витрины дешевле на ${String(r.spellDiscountAfter)}`;
  // Подъём-ХВОСТ (D214) обязан объяснить себя прямо в строке: в СПИСКЕ
  // тот же подъём стоит с нулём и запретом («здоровья 1 при пороге 15»),
  // и без этих слов план противоречил бы списку на глазах у игрока — тот
  // самый класс подачи, из-за которого пропадал скрытый шаг усиления.
  const burning = r.blockedByHp === true ? ' — иначе золото сгорает' : '';
  // Что клич даст через плательщиков борда — там же и по тому же доводу
  // (part75): «РАЗЫГРАТЬ Red Chromadrake, продав Draconic Warden» без этих
  // слов читалось как продажа ни за что, хотя драконы росли перед боем.
  const gain = r.battlecryGain === undefined ? '' : ` — клич: ${r.battlecryGain}`;
  return `${ACTION_LABEL[r.action]}${what}${branch}${price}${thenBuy}${victim}${magnet}${target}${pair}${goal}${hold}${pick}${discount}${burning}${gain}`;
}

/** Вариант выбора тринкета одной строкой. */
export function trinketLine(t: TrinketAdvice): string {
  return `${t.name} — ${t.reason}`;
}

/**
 * Досчёт покупок боем — одной строкой.
 *
 * Три исхода, и различать их обязана сама строка: разброс в шуме
 * («лучший» случаен, полагаться не на что), бой подтвердил эвристику,
 * бой предпочёл ДРУГУЮ покупку — последнее и есть то, ради чего досчёт
 * существует, и оно выделено словами. Давность цели — та же честная
 * оговорка, что у расстановки: числа против старой картинки слабее.
 */
export function buyCheckLine(
  result: BuyCheckResult,
  target: PositionTarget,
  cards: CardIndex,
): string {
  const name = (id: string): string => cards.info(id)?.name ?? id;
  const best = result.outcomes[0];
  if (best === undefined) return 'по бою: считать нечего';

  const chain = result.outcomes
    .map((o) => `${name(o.cardId)} ${o.outcome.toFixed(0)}%`)
    .join(' > ');
  const source = ` (${opponentSource(target)})`;

  if (!result.decisive) {
    // Нулевой разброс при насыщенном исходе — не «кандидаты равны»,
    // а «цель уже не соперник»: против устаревших бордов бой выигрывается
    // любым (тот же симптом, что в оффлайн-сверке против старых картинок).
    const worstOutcome = result.outcomes[result.outcomes.length - 1]?.outcome ?? 0;
    if (worstOutcome >= 99.5) return `по бою этот бой выигрывается любой покупкой${source}`;
    if (best.outcome <= 0.5) return `по бою этот бой проигрывается любой покупкой${source}`;
    return (
      `по бою покупки неразличимы: разброс ${result.spread.toFixed(1)} п.п. ` +
      `при шуме ${result.noise.toFixed(0)}${source}`
    );
  }
  return result.agreed
    ? `по бою подтверждено: ${chain}${source}`
    : `ПО БОЮ ЛУЧШЕ ${name(best.cardId)}: ${chain}${source}`;
}

/** Вариант открытого выбора одной строкой. */
export function choiceLine(c: ChoiceAdvice): string {
  return `${c.name} — ${c.reason}`;
}

/**
 * Прогноз места одной строкой — для терминала и для тестов подачи.
 *
 * Три вещи вместе и в одной строке: число, его типичная ошибка и выборка,
 * по которой обучено. Порознь они врут: 3.4 без «± 1.7» читается как знание,
 * а «± 1.7» без выборки не даёт возразить. Слова «прогноз, не совет» стоят
 * тут не для вежливости — из этого числа НЕ выводится ни одно действие,
 * так записано в предрегистрации замера (docs/ml.md).
 */
export function forecastLine(forecast: PlaceForecast): string {
  return (
    `ожидаемое место ${forecast.place.toFixed(1)} ± ${forecast.error.toFixed(1)}` +
    ` — прогноз, не совет; по ${String(forecast.games)} партиям`
  );
}

/** Склонение слова «борд» при числе: 41 борд, 42 борда, 45 бордов. */
function boardsWord(n: number): string {
  const last = n % 10;
  const tens = n % 100;
  if (last === 1 && tens !== 11) return 'борд';
  if (last >= 2 && last <= 4 && (tens < 12 || tens > 14)) return 'борда';
  return 'бордов';
}

/**
 * Ниже скольких процентов смерть не печатается вовсе.
 *
 * Один процент — это граница, за которой число округляется в ноль, а «смерть
 * в 0 %» занимает строку и ничего не сообщает. Порог не про уверенность
 * в счёте (за ним полторы тысячи симуляций поля), а про то, что молчание
 * здесь — тоже ответ: пока строки нет, ближайший бой не смертелен.
 *
 * Живёт рядом с форматированием, а не в оверлее, потому что подач две —
 * окно и терминал, — а порог обязан быть один. Обратное направление
 * (константа в `view.ts`) дало бы цикл: вид уже берёт отсюда строки.
 */
export const MIN_DEATH_TO_SHOW = 1;

/** Печатать ли смерть этим числом, или молчать. */
export const deathShown = (deathPercent: number): boolean => deathPercent >= MIN_DEATH_TO_SHOW;

/**
 * Сила стола одной строкой — для терминала.
 *
 * Говорит ровно то же, что блок оверлея, и теми же словами: доля выигранных
 * боёв против поля этого хода, размер поля, цена поражения рядом с запасом
 * здоровья и доля боёв, в которых игрок не доживает до следующего хода.
 * Вердикта нет намеренно — «усиливаться или качаться» ближайшим боем
 * не решается (см. `OverlayStrength`), и слово «слабый» тут было бы советом,
 * которого замер не подтверждает.
 */
export function strengthLine(strength: FieldStrength, hp: number): string {
  // «сейчас» — то же слово и по той же причине, что в оверлее: в начале хода
  // борд ещё не укомплектован, и на part44 оценка до покупок и после
  // расходилась как 6 % против 70 %.
  const head =
    `ваш стол берёт сейчас ${strength.percent.toFixed(0)} % боёв ` +
    `${String(strength.tavernTurn)}-го хода таверны — не совет; ` +
    `поле ${String(strength.boards)} ${boardsWord(strength.boards)} соперников`;
  // Смерть — отдельным хвостом, а не вместо цены поражения: в терминале
  // строка не обрезается, и обе величины помещаются. В оверлее место дорого,
  // и там смерть цену вытесняет (`upgradeRisk` в view.ts).
  const death = deathShown(strength.deathPercent)
    ? `; смерть в ${strength.deathPercent.toFixed(0)} %`
    : '';
  // Цена поражения печатается только там, где за ней стоит не горстка боёв:
  // порог и довод — у `MIN_LOSSES_TO_SHOW` в overlay/view.ts.
  if (strength.damageOnLoss === null || strength.damageLosses < 8) {
    return `${head}; у вас ${String(hp)} hp${death}`;
  }
  return (
    `${head}; поражение здесь стоит ~${strength.damageOnLoss.toFixed(0)} hp, ` +
    `у вас ${String(hp)}${death}`
  );
}

/**
 * План трат хода одной строкой: чем занять ВСЁ золото.
 *
 * Отдельные советы — это ранжирование действий, а ход состоит из нескольких:
 * подняться и купить, купить и купить, разыграть из руки и обновиться.
 * Судьба остатка называется здесь же: золото сгорает в конце хода, и молчать
 * об этом нельзя. Хвост «дальше по новой витрине» ставится, когда план
 * оборвался на обновлении: что там будет, никто не знает.
 */
export const MAX_PLAN_STEPS = 4;

export function spendPlanLine(plan: SpendPlan, cards: CardIndex): string {
  // Пометки «исход неизвестен» на шаге нет намеренно: план говорит, ЧТО
  // делать, и знак вопроса у тёмного дара читался бы как сомнение в самом
  // совете. Неизвестность видна там, где она важна, — в хвосте строки.
  //
  // Длина ограничена: план из шести шагов с целями заклинаний занимает
  // в оверлее три строки из трёх, вытесняя расстановку. Первые четыре шага
  // — это все крупные траты; хвост (дар, обновление) виден и в списке
  // советов ниже.
  const shown = plan.steps.slice(0, MAX_PLAN_STEPS);
  const hidden = plan.steps.slice(MAX_PLAN_STEPS);
  const steps = shown.map((s) => recommendationLine(s.recommendation, cards));
  if (hidden.length > 0) {
    // Усиление ВСЕГО борда план держит в хвосте по построению (D210:
    // сыгранное раньше замен, оно достанется проданным), а хвост — ровно
    // та часть строки, которую срезает ограничение длины. На part52 (ход 25)
    // так пропал главный шаг хода: Azerite Empowerment на 154 очка стоял
    // шестым из семи, а список советов называл его ПЕРВОЙ строкой — игрок
    // видел противоречие «сначала Gearfin» против «сначала Azerite» и не
    // видел, что план покупает то же самое, только позже.
    //
    // Поэтому скрытое усиление всего борда называется по имени. Порогов
    // тут нет: признак `buffsWholeBoard` у шага уже посчитан.
    const named = hidden
      .filter((s) => s.recommendation.buffsWholeBoard === true)
      .map((s) => recommendationLine(s.recommendation, cards));
    steps.push(
      named.length === 0
        ? `…и ещё ${String(hidden.length)}`
        : `…и ещё ${String(hidden.length)}, среди них ${named.join(', ')}`,
    );
  }
  const tail = plan.truncated
    ? ' → дальше по новой витрине'
    : plan.goldLeft > 0
      ? `; остаётся ${String(plan.goldLeft)} — сгорит${burnReason(plan)}`
      : '';
  return `ПЛАН ХОДА: ${steps.join(' → ')}${tail}`;
}

/** «: причина» к слову «сгорит» — или пусто, если причина не названа (part51). */
function burnReason(plan: SpendPlan): string {
  return plan.burnNote == null ? '' : `: ${plan.burnNote}`;
}

/**
 * Чем кончился ход — словами, для блока плана в оверлее.
 *
 * У строки `spendPlanLine` хвост взаимоисключающий: при обрыве она про остаток
 * молчит вовсе. Это записанное решение с доводом — что купить дальше, решит
 * новая витрина, а не мы, — и оно остаётся: у строки место одно, и выбирать
 * ей приходится. У блока места два, и там молчание об остатке уже не экономия,
 * а потеря: `goldLeft` посчитан, и обещанные после обновления покупки из него
 * вычтены.
 *
 * Слово «сгорит» при обрыве не ставится ни при каком остатке: витрина будет
 * другая, и утверждать сгорание там мы не вправе.
 */
export function spendPlanOutcome(plan: SpendPlan): string | null {
  if (plan.truncated) {
    return plan.goldLeft > 0
      ? `дальше по новой витрине; остаётся ${String(plan.goldLeft)}`
      : 'дальше по новой витрине';
  }
  return plan.goldLeft > 0 ? `остаётся ${String(plan.goldLeft)} — сгорит${burnReason(plan)}` : null;
}

/** План розыгрыша одной строкой: тела по порядку, магниты с целью. */
export function planLine(steps: readonly PlanStep[], cards: CardIndex): string {
  const parts = steps.map((s) => {
    const sold = s.sellFirst === null ? '' : ` (продав ${minionLabel(s.sellFirst, cards)})`;
    return s.magnetizeTo === null
      ? `${minionLabel(s.minion, cards)}${sold}`
      : `${minionLabel(s.minion, cards)} примагнитить к ${minionLabel(s.magnetizeTo, cards)}`;
  });
  return `РАЗЫГРАТЬ ПО ПОРЯДКУ: ${parts.join(', затем ')}`;
}

/** Доля побед оценки, в процентах. */
export function winPercent(estimate: { readonly sims: number; readonly won: number }): number {
  return estimate.sims === 0 ? 0 : (estimate.won / estimate.sims) * 100;
}


/**
 * Устарела ли картинка противника настолько, что числам верить нельзя.
 *
 * Порог показной, а не замеренный: за четыре хода противник успевает дважды
 * сходить в таверну. Замерено другое — что в обеих фикстурах давность доходит
 * до 17 ходов, и там счёт даёт 100% побед против борда, которого давно нет
 * (docs/live.md).
 */
export const STALE_TURNS_LIMIT = 4;

export function opponentStale(target: PositionTarget): boolean {
  if (target.kind === 'single') {
    return target.opponent.source === 'lastSeen' && target.opponent.staleTurns > STALE_TURNS_LIMIT;
  }
  // Поле устарело, только когда устарел КАЖДЫЙ борд в нём: пока хоть одна
  // картинка свежа, средний исход опирается не только на прошлое.
  return target.boards.every((b) => b.staleTurns > STALE_TURNS_LIMIT);
}

/** «1 ход», «3 хода», «13 ходов» — подпись не имеет права быть безграмотной. */
function turnsLabel(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  const word =
    mod100 >= 11 && mod100 <= 14
      ? 'ходов'
      : mod10 === 1
        ? 'ход'
        : mod10 >= 2 && mod10 <= 4
          ? 'хода'
          : 'ходов';
  return `${String(n)} ${word}`;
}

export function opponentSource(target: PositionTarget): string {
  if (target.kind === 'field') {
    const stale = target.boards.map((b) => b.staleTurns);
    const min = Math.min(...stale);
    const max = Math.max(...stale);
    const age = min === max ? turnsLabel(min) : `${String(min)}–${String(max)} ходов`;
    const count = target.boards.length;
    return `в среднем по полю из ${String(count)} ${count === 1 ? 'борда' : 'бордов'}, давность ${age}`;
  }
  return target.opponent.source === 'lastSeen'
    ? `по борду ${String(target.opponent.staleTurns)} ходов давности`
    : 'по текущему бою';
}

/** Почему расстановку считать не на чем. */
export function noOpponentReason(opponent: ResolvedOpponent): string {
  return opponent.source === 'unknown'
    ? 'противник неизвестен'
    : 'чужих бордов ещё не видели — считать не против кого';
}

/**
 * Совет по расстановке словами: что переставить и чего это стоит.
 *
 * `paidSlot` — приписка про ПЛАТНЫЙ край борда (part39). Она нужна обеим
 * половинам совета, и «менять нечего» нуждается в ней даже больше:
 * молчание советник произносит по ближайшему бою, а край получает
 * усиление КАЖДЫЙ ход, и игрок читает такое молчание как одобрение
 * порядка целиком. Отдельным параметром, а не чтением состояния внутри:
 * `format.ts` про `GameState` не знает, и заводить эту связь ради одной
 * строки незачем.
 */
export function positionLine(
  advice: PositionAdvice,
  target: PositionTarget,
  cards: CardIndex,
  notes: readonly (string | null)[] = [],
): string {
  // Смерти здесь НЕТ, и это решение замера, а не недосмотр (`spike:lethal`,
  // 22.09, docs/quality.md). Против ОДНОГО соперника предсказание смерти
  // честно внизу и переоценивает наверху: в корзине «≥ 50 %» симулятор
  // обещал 86.7 % на 47 боях, а игрок умер в 61.7 %. Против поля, где
  // соперников сорок и крайние приговоры усредняются, то же предсказание
  // калибровано целиком — поэтому число стоит в блоке силы и молчит тут.
  const odds = `${winPercent(advice.report.current.estimate).toFixed(0)}% побед`;
  const spent = `${opponentSource(target)}, ${String(advice.elapsedMs)} мс`;
  const best = advice.top[0];
  // Приписок бывает несколько, и все они об одном: чего расстановка НЕ
  // считает (платный край борда, раж, платящий картой). Список, а не пара
  // параметров: следующая такая слепота допишется одной строкой у места,
  // где её нашли, а не расширением подписи этой функции.
  const tail = notes
    .filter((n): n is string => typeof n === 'string' && n !== '')
    .map((n) => `; ${n}`)
    .join('');

  if (!advice.improves || best === undefined) {
    return `менять нечего (${odds}, ${spent})${tail}`;
  }
  return (
    `${best.board.map((m) => minionLabel(m, cards)).join(' → ')}` +
    `  +${advice.gain.toFixed(1)} п.п. к ${odds} (${spent})${tail}`
  );
}
