/**
 * Замер: кому отдавать заклинание, дающее СТАТЫ И ПРОВОКАЦИЮ?
 *
 *   npm run spike:taunttarget
 *
 * ## Зачем
 *
 * part43, ход 25: план советовал «РАЗЫГРАТЬ Tricky Trousers (+1/+2
 * и провокация) → на Headhunter Gryphon 47/49» — на крупнейшее тело борда,
 * как велит нынешнее правило цели. Игрок возразил: у грифона «боевой раж»,
 * а рядом стоят два Голдринна, чей ХРИП усиливает всех зверей, — провокацию
 * логичнее отдать волку.
 *
 * Замер на самой точке (против ФАКТИЧЕСКОГО борда соперника следующего хода,
 * 8000 симуляций) показал больше, чем спрашивал игрок:
 *
 *   без заклинания                              15.1 %
 *   на Headhunter Gryphon 47/49 (наш совет)     14.6 %   ← хуже, чем не играть
 *   на Goldrinn 31/7 (вариант игрока)           16.5 %
 *   на Goldrinn 7/7 (мелкая копия)              28.6 %
 *   на Turquoise Skitterer 13/13 (зол, перерожд) 0.7 %
 *
 * Контроль: те же +1/+2 БЕЗ провокации дают 15.0–15.6 % куда ни повесь,
 * то есть весь разброс — от того, кому досталась ПРОВОКАЦИЯ, а не статы.
 * Одна точка правилом не становится, поэтому — корпусный замер.
 *
 * ## Предрегистрация — объявлено ДО прогона
 *
 * **Вопрос.** Улучшает ли ближайший бой перенос заклинания «статы плюс
 * провокация» с крупнейшего тела на другое?
 *
 * **Точки.** Все точки решения таверны (`readTavernTurns`) фикстур
 * `CURRENT_BUILD_PARTS`, где на борде есть хотя бы ДВА миньона без
 * провокации и есть цель боя (следующий противник или поле виденных
 * бордов).
 *
 * **Ветви.** Заклинание одно и то же — «+1/+2 и провокация» (Tricky
 * Trousers `BG28_520`, карта из жалобы), меняется только получатель:
 *
 *  - A — цель НЫНЕШНЕГО правила (`buffTarget` с флагом провокации:
 *    крупнейший с фильтрами движка и кандидата в продажу). Это то, что
 *    советник говорит сегодня.
 *  - B — НАИМЕНЬШЕЕ тело борда без провокации.
 *  - C — носитель ХРИПА, усиливающего свой борд В БОЮ, наименьший из таких.
 *    Точки без такого носителя в эту пару не входят вовсе.
 *  - N — заклинание НЕ ИГРАЕТСЯ вовсе. Ветвь ОПИСАТЕЛЬНАЯ, вердикта по ней
 *    нет и не будет: она добавлена после первого прогона, потому что
 *    на точке жалобы наш совет оказался хуже бездействия (14.55 против
 *    15.05 без заклинания), и хотелось знать, случайность это или правило.
 *    Порогов приёмки она не трогает.
 *
 * **Мера.** Исход точки — победа плюс половина ничьей, 2000 симуляций
 * на ветвь, зерно фиксировано, поле бордов делится поровну (как в живом
 * режиме).
 *
 * **Приёмка.** Правило «провокация — наименьшему телу» вносится, если
 * среднее B−A положительно и по модулю превышает две стандартные ошибки.
 * Отдельно и с той же планкой читается C−A на своём подмножестве: если
 * берёт только оно, правило узкое и называется классом карт («носитель
 * хрипа, усиливающего борд»), а не общим «наименьшему». Если ни одна пара
 * планку не берёт — правило остаётся прежним, а ответ игроку: «на этой
 * точке разрыв двадцать пунктов, на корпусе польза не показана», с числом
 * и порогом рядом.
 *
 * **Оговорки, тоже до прогона.**
 *  - меряется только БЛИЖАЙШИЙ бой, а провокация и статы остаются навсегда;
 *  - точка решения снята в начале хода, а заклинание играется в конце —
 *    борд к тому моменту бывает больше;
 *  - «+1/+2 и провокация» взято от Tricky Trousers; у других заклинаний
 *    класса статы другие, и результат переносится по смыслу, а не по замеру;
 *  - ветвь C зависит от того, как мы читаем «хрип усиливает борд», — список
 *    таких карт печатается вместе с числами, и его можно проверить глазами;
 *  - у части точек все ветви дают тождественный исход (борд решает бой
 *    и без провокации) — число ненулевых разностей печатается рядом.
 *
 * ## Два прогона выброшены, и оба — из-за ПРИБОРА, а не из-за чисел
 *
 * Записано здесь, потому что иначе следующий читатель сочтёт вердикт
 * третьим взглядом на одни данные (как у `spike:buff`), а это не так:
 * данные те же, но первые два прогона отвечали не на тот вопрос.
 *
 *  1. Класс ветви C был широким: предикат искал «хрип» и «+N» по ВСЕМУ
 *     тексту, и в выборку попал Forest Rover, у которого усиление
 *     в БАТЛКРАЕ, а хрип призывает жука, — 27 точек из 50. Теперь
 *     смотрится клауза самого хрипа (10 карт пула из 396).
 *  2. Ветвь A брала цель обычного усиления, без флага провокации, —
 *     то есть без фильтра движков, которым цель заклинания с провокацией
 *     как раз и отличается. Сравнивать надо С ТЕМ, ЧТО СОВЕТНИК ГОВОРИТ.
 *
 * Числа выброшенных прогонов, чтобы их не пришлось искать: первый дал
 * B−A = −0.415 при пороге 0.397 (382 точки) и C−A = −0.821 при пороге
 * 1.733 (50 точек).
 */
import { loadCardIndex, type CardIndex } from '../../data/cards.js';
import { CURRENT_BUILD_PARTS, readFixtureGame } from '../../data/fixtureGames.js';
import type { Minion } from '../../state/types.js';
import { endOfTurnAuraGains, withEndOfTurnAuras } from '../battle/endOfTurn.js';
import { toBattleInfo, withPlayerBoard } from '../battle/mapper.js';
import { createBattleSimulator } from '../battle/simulator.js';
import { battleQuestion } from '../position/advisor.js';
import { withSeededRandom } from '../position/rng.js';
import { buffTarget } from './advisor.js';
import { summarize } from './statAnalysis.js';
import { readTavernTurns } from './turns.js';

const FIXTURES = CURRENT_BUILD_PARTS;

const SIMULATIONS = 2000;
const SEED = 20_260_906;

/** Статы заклинания из жалобы: Tricky Trousers даёт +1/+2 и провокацию. */
const BUFF_ATTACK = 1;
const BUFF_HEALTH = 2;

function stats(m: Minion): number {
  return (m.attack ?? 0) + (m.health ?? 0);
}

/**
 * Хрип, который усиливает НАШ БОРД В БОЮ.
 *
 * Именно в бою: «Deathrattle: Your Tavern spells give an extra +1 Attack»
 * (Friendly Geist) и «Your Blood Gems give…» платят в таверне, и умирать
 * ради них раньше времени незачем. «Give a random minion in your hand»
 * (Scourfin) тоже мимо — усиление уезжает в руку.
 *
 * Список печатается прогоном: правило читается текстом, и проверять его
 * надо глазами по именам карт, а не по вере в шаблон.
 */
function buffsBoardOnDeath(m: Minion, cards: CardIndex): boolean {
  const text = cards.info(m.cardId)?.text ?? '';
  // Смотрится ИМЕННО клауза хрипа, а не весь текст. Первый прогон замера
  // проверял текст целиком, и класс оказался чужим: Forest Rover попал
  // в него батлкраем («Battlecry: Your Beetles have +{2}/+{3} this game.
  // Deathrattle: Summon a Beetle») и дал 27 точек из 50 — больше половины
  // выборки мерили не то, о чём спрашивал игрок.
  const head = /deathrattle\s*:?/i.exec(text);
  if (head === null) return false;
  const clause = text.slice(head.index + head[0].length);
  if (!/\+\s*(?:\{\d\}|\d+)/.test(clause)) return false;
  // Усиление должно доезжать до БОЯ: «Your Tavern spells give an extra…»
  // (Friendly Geist), «Your Blood Gems…» (Sanguine Champion) и «a random
  // minion in your hand» (Scourfin) платят в таверне или в руку, и умирать
  // ради них раньше времени незачем.
  if (/\bin your hand\b|\btavern\s+spells?\b|\bblood\s+gems?\b|\bgive an extra\b/i.test(clause)) {
    return false;
  }
  return /\b(?:your|friendly)\b/i.test(clause);
}

/** Тот же борд, но названному миньону добавлены статы и провокация. */
function patched(board: readonly Minion[], target: Minion): readonly Minion[] {
  return board.map((m) =>
    m.entityId === target.entityId
      ? {
          ...m,
          attack: (m.attack ?? 0) + BUFF_ATTACK,
          health: (m.health ?? 1) + BUFF_HEALTH,
          maxHealth: m.maxHealth === null ? null : m.maxHealth + BUFF_HEALTH,
          taunt: true,
        }
      : m,
  );
}

interface Point {
  readonly part: number;
  readonly turn: number;
  /** B − A: наименьшее тело против нынешней цели. */
  readonly smallest: number;
  /** C − A: носитель хрипа против нынешней цели; `null` — носителя нет. */
  readonly deathrattle: number | null;
  /** N − A: не играть вовсе против нынешней цели. Описательная ветвь. */
  readonly skip: number;
}

function main(): void {
  const cards = loadCardIndex();
  const simulator = createBattleSimulator();

  const points: Point[] = [];
  const carriers = new Map<string, number>();
  let skipped = 0;

  for (const part of FIXTURES) {
    const text = readFixtureGame(part);
    if (text === null) continue;
    const turns = readTavernTurns(text);
    let used = 0;

    for (const { state } of turns) {
      const bodies = state.board.filter((m) => !m.taunt);
      const question = battleQuestion(state);
      if (bodies.length < 2 || question === null) {
        skipped += 1;
        continue;
      }
      // Нынешняя цель — та же функция, что называют советы, и обязательно
      // с флагом ПРОВОКАЦИИ: он включает фильтр движков (part15), которым
      // цель заклинания с провокацией и отличается от цели обычного
      // усиления. Без флага замер сравнивал бы с правилом, которого
      // советник не применяет.
      const current = buffTarget(state, { cards }, undefined, true);
      if (current === null) {
        skipped += 1;
        continue;
      }
      const smallest = bodies.reduce((a, b) => (stats(b) < stats(a) ? b : a));
      const dying = bodies.filter((m) => buffsBoardOnDeath(m, cards));
      for (const m of dying) {
        const name = cards.info(m.cardId)?.name ?? m.cardId;
        carriers.set(name, (carriers.get(name) ?? 0) + 1);
      }
      const carrier =
        dying.length === 0 ? null : dying.reduce((a, b) => (stats(b) < stats(a) ? b : a));

      const auraGains = endOfTurnAuraGains(state.board, simulator.cards);
      const bases = question.setups.map((s) => toBattleInfo(s, 1));
      const per = Math.max(1, Math.floor(SIMULATIONS / bases.length));

      // Один и тот же прогон на любом борде: поле, зерно и число симуляций
      // общие, иначе разность померила бы зерно, а не заклинание.
      const outcome = (board: readonly Minion[]): number => {
        const withAuras = withEndOfTurnAuras(board, auraGains);
        let sum = 0;
        for (const [i, base] of bases.entries()) {
          const r = withSeededRandom(SEED + i, () =>
            simulator.run(withPlayerBoard(base, withAuras), per),
          );
          sum += r.wonPercent + r.tiedPercent / 2;
        }
        return sum / bases.length;
      };
      const run = (target: Minion): number => outcome(patched(state.board, target));

      const a = run(current);
      points.push({
        part,
        turn: state.turn,
        smallest: run(smallest) - a,
        deathrattle: carrier === null ? null : run(carrier) - a,
        skip: outcome(state.board) - a,
      });
      used += 1;
    }

    console.log(`${`part${String(part)}`.padEnd(8)} точек ${String(used).padStart(3)}`);
  }

  if (points.length === 0) {
    console.log('точек не нашлось');
    return;
  }

  const smallest = summarize(points.map((p) => p.smallest));
  const skip = summarize(points.map((p) => p.skip));
  const withCarrier = points.flatMap((p) => (p.deathrattle === null ? [] : [p.deathrattle]));
  const carrierPair = summarize(withCarrier);

  console.log('\n═══ итог ═══');
  console.log(`  точек решения:            ${String(smallest.n)} (пропущено ${String(skipped)})`);
  console.log('\n  B−A: НАИМЕНЬШЕЕ тело против нынешней цели (крупнейшей):');
  console.log(`    ненулевых разностей:    ${String(smallest.moved)}`);
  console.log(`    среднее:                ${smallest.mean.toFixed(3)} п.п.`);
  console.log(`    стандартная ошибка:     ${smallest.se.toFixed(3)} п.п.`);
  console.log(`    минимальный различимый: ${(2 * smallest.se).toFixed(3)} п.п. (порог приёмки)`);

  console.log('\n  C−A: носитель ХРИПА, усиливающего борд, против нынешней цели:');
  if (carrierPair.n === 0) {
    console.log('    точек с таким носителем не нашлось');
  } else {
    console.log(`    точек:                  ${String(carrierPair.n)}`);
    console.log(`    ненулевых разностей:    ${String(carrierPair.moved)}`);
    console.log(`    среднее:                ${carrierPair.mean.toFixed(3)} п.п.`);
    console.log(`    минимальный различимый: ${(2 * carrierPair.se).toFixed(3)} п.п.`);
  }

  console.log('\n  N−A: НЕ ИГРАТЬ вовсе против нынешней цели (описательная, вердикта нет):');
  console.log(`    ненулевых разностей:    ${String(skip.moved)}`);
  console.log(`    среднее:                ${skip.mean.toFixed(3)} п.п.`);
  console.log(`    стандартная ошибка:     ${skip.se.toFixed(3)} п.п.`);

  console.log('\n  носители хрипа, попавшие в замер (карта — сколько точек):');
  for (const [name, n] of [...carriers].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${name.padEnd(30)} ${String(n)}`);
  }

  const verdict = (label: string, s: { mean: number; se: number; n: number }): string => {
    if (s.n === 0) return `${label}: точек нет`;
    if (s.mean > 0 && s.mean > 2 * s.se) return `${label}: ЛУЧШЕ нынешней цели — правило вносится`;
    if (s.mean < 0 && -s.mean > 2 * s.se) return `${label}: ХУЖЕ нынешней цели — правило не вносится`;
    return `${label}: разницы не видно — правила нет`;
  };
  console.log(`\n  ВЕРДИКТ ${verdict('B (наименьшее тело)', smallest)}`);
  console.log(`  ВЕРДИКТ ${verdict('C (носитель хрипа)', carrierPair)}`);
}

main();
