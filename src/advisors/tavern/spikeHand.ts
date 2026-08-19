/**
 * Замер: стоит ли разыгрывать миньона, ценность которого живёт В РУКЕ?
 *
 *   npm run spike:hand
 *
 * ## Зачем
 *
 * part22, три пункта обратной связи из пяти — об одном. Ход 5: план советовал
 * «РАЗЫГРАТЬ Flighty Scout 3/3», а у карты написано «Start of Combat: If this
 * minion is in your hand, summon a copy of it» — она и так выйдет в бой,
 * не занимая места. Конец хода 17: «РАЗЫГРАТЬ Bream Counter 208/206, продав
 * Rodeo Performer», а у карты написано «While this is in your hand, after you
 * play a Murloc, gain +{0}/+{1}» — розыгрыш останавливает рост. Игрок оставил
 * обе в руке и пришёл первым; к ходу 23 счетовод дорос до 670/668.
 *
 * У жалобы есть и вторая сторона, которую игрок назвал прямо: «мурлоки часто
 * играют через улучшение карт в руке». В пуле 14 миньонов с «in your hand»,
 * и ВСЕ ЧЕТЫРНАДЦАТЬ — мурлоки: трое работают из руки, одиннадцать её едят
 * («Gain the Attack of the highest-Attack minion in your hand» — Costume
 * Enthusiast, он же стоял на борде part22). Разыгранная карта перестаёт
 * кормить борд, и советник этого не видел вовсе: рука считалась складом
 * тел, которые надо поскорее выставить.
 *
 * Различать это мнением нельзя, а замером — можно: симулятор ОБЕ стороны
 * умеет (`flighty-scout.js` и `costume-enthusiast.js` читают
 * `playerEntity.hand`), и с part21 рука до него доходит.
 *
 * ## Предрегистрация — объявлено ДО прогона
 *
 * **Вопрос.** Что делает с ближайшим боем розыгрыш миньона из руки —
 * отдельно для карт, работающих из руки, и для рук, которыми борд питается?
 *
 * **Точки.** Все точки решения таверны (`readTavernTurns`) фикстур билда
 * 248348 (part4–part22), где есть цель боя (следующий противник или поле
 * виденных бордов) и в руке есть хотя бы один миньон. Из каждой точки
 * берётся не больше одного кандидата на группу — крупнейший по статам.
 *
 * **Ветви.** Для кандидата `m`:
 *  - ОСТАВИТЬ: борд как есть, рука как есть;
 *  - РАЗЫГРАТЬ: борд плюс `m` (на свободное место) либо борд минус слабейший
 *    плюс `m` (на полном борде), рука минус `m`.
 * Разность считается «РАЗЫГРАТЬ минус ОСТАВИТЬ»: положительная означает, что
 * розыгрыш ближайший бой УЛУЧШАЕТ.
 *
 * **Группы.**
 *  1a. «играет из руки» — текст `(?:if|while) this minion is in your hand`
 *      с призывом (Flighty Scout). Ближайший бой видит эффект ЦЕЛИКОМ:
 *      копия призывается в самом бою. Вердикт по этой группе полноценный.
 *  1b. «растёт в руке» — «While this is in your hand… gain +{0}/+{1}»
 *      (Bream Counter, Timewarped Astrogill). Ближайший бой видит только
 *      тело и НЕ видит будущего роста. Поэтому здесь заранее объявлено:
 *      отрицательный результат — довод, ПОЛОЖИТЕЛЬНЫЙ НЕ ОПРОВЕРГАЕТ игрока
 *      (та же оговорка, что у экономики, docs/tavern.md).
 *  2.  «борд питается рукой» — обычная карта руки при кормильце на борде.
 *      Ближайший бой видит и это целиком: кормильцы читают руку на старте боя.
 *  3.  КОНТРОЛЬ — обычная карта руки, кормильцев на борде нет. Ожидание
 *      объявляется заранее: разность должна быть ЗАМЕТНО ПОЛОЖИТЕЛЬНОЙ.
 *      Если контроль нуля не отличит, инструмент негоден, и остальные
 *      группы читать нельзя.
 *
 * Исход точки — победа плюс половина ничьей, 2000 симуляций на ветвь, зерно
 * фиксировано, поле бордов делится поровну (как в живом режиме).
 *
 * **Приёмка.**
 *  - Правило «не советовать розыгрыш карты, работающей из руки» вносится,
 *    если среднее группы 1a отрицательно и по модулю больше двух стандартных
 *    ошибок.
 *  - Правило «розыгрыш обедняет кормильцев» вносится по группе 2 тем же
 *    порогом.
 *  - Группа 1b правила сама не решает: её роль — показать, ЧТО ИМЕННО видит
 *    ближайший бой, когда рост в руке ему невидим.
 *  - Контроль (группа 3) обязан быть положительным; иначе прогон
 *    объявляется негодным целиком.
 * Минимальный различимый эффект печатается рядом с каждым средним, чтобы
 * «не нашли» нельзя было спутать с «не могли найти».
 *
 * **Оговорки, тоже до прогона.**
 *  - меряется только БЛИЖАЙШИЙ бой: рост в руке, тройки и будущие покупки
 *    ему невидимы;
 *  - точка решения снята в начале хода, а розыгрыш случается по ходу —
 *    борд к тому моменту бывает другим;
 *  - на полном борде жертвой берётся слабейший по статам, а не по правилам
 *    продажи: замер про руку, а не про выбор жертвы;
 *  - золото не тратится ни в одной ветви — сравниваются ровно рука и борд.
 *
 * ## Отменённый прогон — записан, а не стёрт
 *
 * Первый прогон (17.08) объявлен НЕГОДНЫМ по собственному правилу приёмки:
 * контроль не превысил своего порога (3.343 при 3.976), а группа 1a осталась
 * ПУСТОЙ — при том что Flighty Scout лежал в руке пол-партии part22.
 * Причина — в шаблоне: в снапшоте у карты стоит «If this\nminion is in your
 * hand», и шаблон с обычным пробелом не совпал молча. Это ровно та ловушка,
 * что записана в CLAUDE.md после part16. Шаблоны переписаны на `\s+`,
 * пороги и группы остались прежними — переигран прогон, а не критерий.
 *
 * Второй прогон контроль тоже не взял (3.390 при 4.030), и диагностика
 * показала второй дефект ИНСТРУМЕНТА: в контроль попадал Polarizing
 * Beatboxer из part8 — карта под замком тринкета (`LITERALLY_UNPLAYABLE`),
 * которую разыграть НЕЛЬЗЯ. Одна такая точка давала −15 п.п. и разгоняла
 * разброс контроля. Ветвь «разыграть» обязана быть выполнимой в игре,
 * поэтому неиграбельные и смертники исключены тем же условием, каким
 * их отсекает `playRules`. Критерии приёмки снова не менялись.
 */
import { readFileSync } from 'node:fs';

import { loadCardIndex, type CardIndex } from '../../data/cards.js';
import type { Minion } from '../../state/types.js';
import { endOfTurnAuraGains, withEndOfTurnAuras } from '../battle/endOfTurn.js';
import { toBattleInfo } from '../battle/mapper.js';
import { createBattleSimulator } from '../battle/simulator.js';
import { battleQuestion } from '../position/advisor.js';
import { withSeededRandom } from '../position/rng.js';
import { summarize, type SpikeSummary } from './statAnalysis.js';
import { isHandWorker } from './advisor.js';
import { DEFAULT_TAVERN_RULES, type TavernRules } from './rules.js';
import { readTavernTurns } from './turns.js';
import { CURRENT_BUILD_LOGS } from '../../data/fixtureGames.js';

const FIXTURES = CURRENT_BUILD_LOGS;

const SIMULATIONS = 2000;
const SEED = 20_260_817;

type Group = 'playsFromHand' | 'growsInHand' | 'feeders' | 'control';

const GROUP_LABEL: Readonly<Record<Group, string>> = {
  playsFromHand: '1a «играет из руки» (вердикт полноценный)',
  growsInHand: '1b «растёт в руке» (положительное не опровергает)',
  feeders: '2  «борд питается рукой» (вердикт полноценный)',
  control: '3  КОНТРОЛЬ — обычная карта, кормильцев нет',
};

function textOf(m: Minion, cards: CardIndex): string {
  return cards.info(m.cardId)?.text ?? '';
}

function matches(text: string, words: readonly string[]): boolean {
  return text !== '' && words.some((w) => new RegExp(w, 'i').test(text));
}

// «Карта, работающая из руки» берётся ИЗ ПРАВИЛА, а не переписывается здесь:
// замер тем и ценен, что меряет ровно ту популяцию, которую отбирает советник.
// Своя копия предиката тихо разошлась бы с ним при первой же правке слов.

/** Он же, но с призывом: эффект случается в самом бою (Flighty Scout). */
function playsFromHand(m: Minion, cards: CardIndex, rules: TavernRules): boolean {
  const text = textOf(m, cards);
  return matches(text, rules.handWorkerWords) && /\bsummons?\b/i.test(text);
}

/** Миньон борда, читающий ЧУЖИЕ карты руки. */
function isHandFeeder(m: Minion, cards: CardIndex, rules: TavernRules): boolean {
  return matches(textOf(m, cards), rules.handFeederWords);
}

function stats(m: Minion): number {
  return (m.attack ?? 0) + (m.health ?? 0);
}

interface Point {
  readonly group: Group;
  readonly part: string;
  readonly turn: number;
  readonly card: string;
  /** РАЗЫГРАТЬ минус ОСТАВИТЬ, п.п. Положительное — розыгрыш помогает. */
  readonly delta: number;
}

function main(): void {
  const cards = loadCardIndex();
  const simulator = createBattleSimulator();
  const rules = DEFAULT_TAVERN_RULES;

  const points: Point[] = [];

  for (const path of FIXTURES) {
    const part = path.split('/')[2] ?? path;
    let used = 0;

    for (const { state } of readTavernTurns(readFileSync(path, 'utf8'))) {
      const question = battleQuestion(state);
      if (question === null || state.hand.length === 0) continue;

      const feederOnBoard = state.board.some((m) => isHandFeeder(m, cards, rules));

      // Кандидат группы — крупнейший подходящий миньон руки. Больше одного
      // кандидата на группу с точки не берём: соседние карты одной руки
      // дают почти одну и ту же разность и раздували бы выборку.
      const pick = (fits: (m: Minion) => boolean): Minion | null => {
        const fitting = state.hand.filter(fits);
        return fitting.length === 0
          ? null
          : fitting.reduce((a, b) => (stats(b) > stats(a) ? b : a));
      };

      // Ветвь «разыграть» обязана быть выполнимой: карту под замком тринкета
      // (`LITERALLY_UNPLAYABLE`) в игре не выставить, и её «розыгрыш» —
      // не решение игрока, а выдумка замера. `playRules` отсекает такие
      // на входе, и замер обязан отсекать так же.
      const playable = (m: Minion): boolean => (m.tags['LITERALLY_UNPLAYABLE'] ?? 0) <= 0;
      const plain = (m: Minion): boolean => playable(m) && !isHandWorker(m, cards, rules);
      const candidates: [Group, Minion | null][] = [
        ['playsFromHand', pick((m) => playable(m) && playsFromHand(m, cards, rules))],
        [
          'growsInHand',
          pick(
            (m) => playable(m) && isHandWorker(m, cards, rules) && !playsFromHand(m, cards, rules),
          ),
        ],
        [feederOnBoard ? 'feeders' : 'control', pick(plain)],
      ];

      const auraGains = endOfTurnAuraGains(state.board, simulator.cards);
      const per = Math.max(1, Math.floor(SIMULATIONS / question.setups.length));

      const run = (board: readonly Minion[], hand: readonly Minion[]): number => {
        const withAuras = withEndOfTurnAuras(board, auraGains);
        let sum = 0;
        for (const [i, setup] of question.setups.entries()) {
          const info = toBattleInfo({ ...setup, playerBoard: withAuras, playerHand: hand }, 1);
          const r = withSeededRandom(SEED + i, () => simulator.run(info, per));
          sum += r.wonPercent + r.tiedPercent / 2;
        }
        return sum / question.setups.length;
      };

      for (const [group, candidate] of candidates) {
        if (candidate === null) continue;

        const rest = state.hand.filter((m) => m.entityId !== candidate.entityId);
        const full = state.board.length >= rules.boardSize;
        const victim = full
          ? state.board.reduce((a, b) => (stats(b) < stats(a) ? b : a))
          : null;
        const played =
          victim === null
            ? [...state.board, candidate]
            : [...state.board.filter((m) => m.entityId !== victim.entityId), candidate];

        points.push({
          group,
          part,
          turn: state.turn,
          card: cards.info(candidate.cardId)?.name ?? candidate.cardId,
          delta: run(played, rest) - run(state.board, state.hand),
        });
        used += 1;
      }
    }

    console.log(`${part.padEnd(8)} точек ${String(used).padStart(3)}`);
  }

  if (points.length === 0) {
    console.log('точек не нашлось');
    return;
  }

  console.log('\n═══ итог ═══');
  const byGroup = new Map<Group, SpikeSummary>();
  for (const group of ['playsFromHand', 'growsInHand', 'feeders', 'control'] as const) {
    const s = summarize(points.filter((p) => p.group === group).map((p) => p.delta));
    byGroup.set(group, s);
    console.log(`\n  ${GROUP_LABEL[group]}`);
    if (s.n === 0) {
      console.log('    точек нет');
      continue;
    }
    console.log(`    точек:                  ${String(s.n)} (разошлись ${String(s.moved)})`);
    console.log(`    среднее (розыгрыш −):   ${s.mean.toFixed(3)} п.п.`);
    console.log(`    минимальный различимый: ${(2 * s.se).toFixed(3)} п.п. (порог приёмки)`);
  }

  const verdict = (g: Group, what: string): string => {
    const s = byGroup.get(g);
    if (s === undefined || s.n === 0) return `${what}: точек нет — не проверено`;
    if (s.mean < 0 && Math.abs(s.mean) > 2 * s.se) return `${what}: розыгрыш ВРЕДИТ — правило вносится`;
    if (s.mean > 0 && Math.abs(s.mean) > 2 * s.se) return `${what}: розыгрыш ПОЛЕЗЕН`;
    return `${what}: разницы не видно`;
  };

  const control = byGroup.get('control');
  const controlOk = control !== undefined && control.n > 0 && control.mean > 2 * control.se;

  console.log('\n  ВЕРДИКТ');
  console.log(
    `    контроль: ${
      controlOk
        ? 'положителен — инструмент годен'
        : 'НЕ положителен — прогон негоден, остальные группы читать нельзя'
    }`,
  );
  console.log(`    ${verdict('playsFromHand', '1a играет из руки')}`);
  console.log(`    ${verdict('feeders', '2  борд питается рукой')}`);
  console.log(
    `    1b растёт в руке: ${(byGroup.get('growsInHand')?.mean ?? 0).toFixed(3)} п.п. — ` +
      'ближайший бой роста не видит, вердикт по группе не выносится',
  );

  // Диагностика, НЕ предрегистрированная и на вердикт не влияющая: на
  // большинстве точек обе ветви дают тождественный исход (борд решает бой
  // и без лишнего тела). У парной разности с нулями среднее и ошибка
  // сжимаются вместе, поэтому отношение то же, — но читать группы рядом
  // проще по точкам, где ветви вообще разошлись.
  console.log('\n  диагностика (не предрегистрирована) — только разошедшиеся точки:');
  for (const group of ['playsFromHand', 'growsInHand', 'feeders', 'control'] as const) {
    const s = summarize(
      points.filter((p) => p.group === group && Math.abs(p.delta) > 0.05).map((p) => p.delta),
    );
    console.log(
      `    ${group.padEnd(14)} n=${String(s.n).padStart(2)}  среднее ${s.mean.toFixed(2).padStart(6)} п.п.` +
        `  порог ${(2 * s.se).toFixed(2)}`,
    );
  }

  // Диагностика, НЕ предрегистрированная: самые крупные расхождения по карте.
  const worst = [...points].sort((a, b) => a.delta - b.delta).slice(0, 5);
  console.log('\n  диагностика (не предрегистрирована) — где розыгрыш хуже всего:');
  for (const p of worst) {
    console.log(
      `    ${p.part} ход ${String(p.turn).padStart(2)}  ${p.card.padEnd(22)} ${p.delta.toFixed(1)} п.п. [${p.group}]`,
    );
  }

  console.log('\n  Оговорки — в шапке файла: только ближайший бой, точка решения');
  console.log('  снята в начале хода, жертва на полном борде — слабейшая по статам.');
}

main();
