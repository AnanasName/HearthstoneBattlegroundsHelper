/**
 * Замер: где правка советника МЕНЯЕТ план хода и чей итоговый борд сильнее.
 *
 *   npm run spike:plandiff -- dump <out.json> [part…]
 *   npm run spike:plandiff -- compare <before.json> <after.json> [симуляций]
 *
 * ## Зачем
 *
 * Сверки (`validate:tavern`, `validate:spend`) отвечают «попадает ли совет
 * в лучший по бою из своих же кандидатов» и правку одного правила видят
 * размытой по сотням ходов. Этот прибор отвечает на вопрос уже: в тех
 * точках, где план ПОСЛЕ правки разошёлся с планом ДО, какой итоговый борд
 * сильнее. Родился на part51: две правки (продажа ради покупки на неполном
 * борде, усиление «Give your minions» на весь борд), и именно он дважды
 * их переделал — docs/tavern.md, «сорок шестая порция».
 *
 * ## Как пользоваться
 *
 * `dump` пишет план каждой точки решения (`readTavernTurns`) партий part4 и
 * дальше, пока находятся логи, либо перечисленных. Запускается ДВАЖДЫ:
 * на коде ДО правки — из чистого worktree на HEAD (память проекта:
 * «данные и замеры — из чистого worktree»), — и на коде ПОСЛЕ. `compare`
 * судит разошедшиеся планы.
 *
 * ## Мера
 *
 * Итоговый борд плана против ПОЛЯ бордов того же хода таверны (снапшот
 * силы стола, `data/field/boards.json`) БЕЗ бордов своей же партии; одно
 * зерно на обе стороны — сравнение парное. Доля = победы + половина ничьих.
 * Среднее и ошибка считаются по ПАРТИЯМ (точки одной партии не независимы);
 * «лучше/хуже» — сдвиг больше 0.25 п.п.
 *
 * ## Что прибор НЕ видит, и это надо помнить, читая числа
 *
 * - **Шаги-заклинания в плане непрозрачны** (`spend.ts`): итоговое
 *   состояние их статов не несёт. Усиление «весь борд» прибор накладывает
 *   сам — и только на тех, кто стоял на борде В МОМЕНТ розыгрыша
 *   (`boardsBefore`); первая версия накладывала на итоговый борд целиком
 *   и перестановку шага не видела. Прочие заклинания не накладываются
 *   ни с какой стороны.
 * - **Подъём таверны, золото следующего хода, карта в руке** итоговым
 *   бордом не меряются вовсе — та же слепота, что у `spike:level`.
 *   Потеря «два тела против подъёма и одного тела» читается здесь как
 *   чистая потеря.
 * - **Поле кончается к 14-му ходу таверны** (меньше двенадцати бордов —
 *   точка без меры).
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { toBattleInfo } from '../battle/mapper.js';
import { sharedBattleSimulator } from '../battle/simulator.js';
import { withSeededRandom } from '../position/rng.js';
import { boardsOfTurn, loadFieldBoards } from '../strength/boards.js';
import { loadCardIndex, type CardIndex } from '../../data/cards.js';
import { fixtureLogPaths, readFixtureGame } from '../../data/fixtureGames.js';
import type { GameState, Minion } from '../../state/types.js';
import { adviseTavern, type Recommendation } from './advisor.js';
import { DEFAULT_TAVERN_RULES, tavernTurnOf } from './rules.js';
import { spendPlan } from './spend.js';
import { readTavernTurns } from './turns.js';

interface DumpRow {
  readonly part: number;
  readonly turn: number;
  readonly top: readonly string[];
  readonly steps: readonly string[];
  /** Кто стоял на борде ПЕРЕД каждым шагом — усиление достаётся только им. */
  readonly boardsBefore: readonly (readonly number[])[];
  readonly goldLeft: number;
  readonly finalBoard: readonly Minion[];
  readonly finalHand: readonly Minion[];
}

const SEED = 20260915;
const FIELD_MIN_BOARDS = 12;

function stepLabel(r: Recommendation): string {
  return (
    `${r.action}:${r.minion?.cardId ?? r.spellCardId ?? ''}` +
    (r.sellFirst ? `/sell:${r.sellFirst.cardId}#${String(r.sellFirst.entityId)}` : '') +
    (r.targetMinion ? `/on:${String(r.targetMinion.entityId)}` : '')
  );
}

function dump(out: string, parts: readonly number[]): void {
  const cards = loadCardIndex();
  const rows: DumpRow[] = [];
  for (const part of parts) {
    const text = readFixtureGame(part);
    if (text === null) continue;
    let n = 0;
    for (const { turn, state } of readTavernTurns(text)) {
      const advice = adviseTavern(state, { cards });
      if (advice === null) continue;
      const plan = spendPlan(state, { cards });
      const last = plan.steps.at(-1)?.stateAfter ?? state;
      rows.push({
        part,
        turn,
        top: advice.recommendations
          .slice(0, 3)
          .map((r) => `${stepLabel(r)}=${r.score.toFixed(2)}`),
        steps: plan.steps.map((s) => stepLabel(s.recommendation)),
        boardsBefore: plan.steps.map((_, i) =>
          (i === 0 ? state : (plan.steps[i - 1]?.stateAfter ?? state)).board.map((m) => m.entityId),
        ),
        goldLeft: plan.goldLeft,
        finalBoard: last.board,
        finalHand: last.hand,
      });
      n++;
    }
    console.log(`part${String(part)}: ${String(n)} точек`);
  }
  writeFileSync(out, JSON.stringify(rows));
  console.log(`записано ${String(rows.length)} точек → ${out}`);
}

/** «+X/+Y» из текста карты: плейсхолдер — индекс в теги, литерал — сам собой. */
function statPairOf(
  text: string,
  data: readonly (number | null)[],
): { attack: number; health: number } | null {
  const m = /\+(?:\{(\d)\}|(\d+))\s*\/\s*\+(?:\{(\d)\}|(\d+))/.exec(text);
  if (m === null) return null;
  const read = (ph: string | undefined, lit: string | undefined): number =>
    ph !== undefined ? (data[Number(ph)] ?? 0) : Number(lit ?? 0);
  return { attack: read(m[1], m[2]), health: read(m[3], m[4]) };
}

const wideText = (text: string): boolean =>
  DEFAULT_TAVERN_RULES.boardWideBuffWords.some((w) => new RegExp(w, 'i').test(text)) &&
  !DEFAULT_TAVERN_RULES.boardWideBuffExcludeWords.some((w) => new RegExp(w, 'i').test(text));

/**
 * Наложить усиления «весь борд» из шагов плана — только на тех, кто стоял
 * на борде в момент розыгрыша. У модальной карты ветвь выбирается по тому же
 * борду: «+X/+Y каждому» против «одному дважды» — что больше в статах.
 */
function applyWideBuffs(
  cards: CardIndex,
  state: GameState,
  row: DumpRow,
): Minion[] {
  let out = row.finalBoard.map((m) => ({ ...m }));
  row.steps.forEach((label, k) => {
    const id = /^(?:buy|play):(\w+)/.exec(label)?.[1];
    if (id === undefined) return;
    const spell = [...state.shopSpells, ...state.handSpells].find((s) => s.cardId === id);
    const info = cards.info(id);
    if (spell === undefined || info === null) return;
    const present = new Set(row.boardsBefore[k] ?? []);
    const bodies = out.filter((m) => present.has(m.entityId));

    const branches = info.mechanics.includes('CHOOSE_ONE')
      ? ['t', 't2'].flatMap((suffix) => {
          const b = cards.info(id + suffix);
          return b === null ? [] : [b.text ?? ''];
        })
      : [info.text ?? ''];
    let best: { wide: boolean; attack: number; health: number; total: number } | null = null;
    for (const text of branches) {
      if (/^(?:\[x\])?\s*at\s+the\s+start\s+of\s+your\s+next\s+turn\b/i.test(text)) continue;
      const pair = statPairOf(text, spell.scriptData);
      if (pair === null) continue;
      const times = /\+\S+\s+twice\b/i.test(text) ? 2 : 1;
      const wide = wideText(text);
      const single = /\bgive\s+a\s+minion\s+\+/i.test(text);
      if (!wide && !single) continue;
      const attack = pair.attack * times;
      const health = pair.health * times;
      const total = (attack + health) * (wide ? bodies.length : 1);
      if (best === null || total > best.total) best = { wide, attack, health, total };
    }
    // Одиночные усиления без «весь борд» в модальной паре не участвуют —
    // у обычной карты «Give a minion» цель выбирает советник, и прибор её
    // не повторяет: такие шаги не накладываются ни с какой стороны.
    if (best === null || (!best.wide && branches.length < 2)) return;
    const hit = best;
    if (hit.wide) {
      out = out.map((m) =>
        present.has(m.entityId)
          ? { ...m, attack: (m.attack ?? 0) + hit.attack, health: (m.health ?? 0) + hit.health }
          : m,
      );
    } else if (bodies.length > 0) {
      const biggest = bodies.reduce((a, b) =>
        (b.attack ?? 0) + (b.health ?? 0) > (a.attack ?? 0) + (a.health ?? 0) ? b : a,
      );
      out = out.map((m) =>
        m.entityId === biggest.entityId
          ? { ...m, attack: (m.attack ?? 0) + hit.attack, health: (m.health ?? 0) + hit.health }
          : m,
      );
    }
  });
  return out;
}

function compare(beforePath: string, afterPath: string, sims: number): void {
  const before = JSON.parse(readFileSync(beforePath, 'utf8')) as DumpRow[];
  const after = JSON.parse(readFileSync(afterPath, 'utf8')) as DumpRow[];
  const cards = loadCardIndex();
  const snapshot = loadFieldBoards();
  if (snapshot === null) throw new Error('нет снапшота поля: npm run field:fit');
  const simulator = sharedBattleSimulator();
  const key = (r: DumpRow): string => `${String(r.part)}:${String(r.turn)}`;
  const byKey = new Map(before.map((r) => [key(r), r]));

  const statesOfPart = new Map<number, Map<number, GameState>>();
  const stateOf = (part: number, turn: number): GameState | undefined => {
    let m = statesOfPart.get(part);
    if (m === undefined) {
      m = new Map(readTavernTurns(readFixtureGame(part) ?? '').map((t) => [t.turn, t.state]));
      statesOfPart.set(part, m);
    }
    return m.get(turn);
  };

  const percent = (s: GameState, part: number, board: readonly Minion[], hand: readonly Minion[]): number | null => {
    const field = boardsOfTurn(snapshot, tavernTurnOf(s.turn), part);
    if (field.length < FIELD_MIN_BOARDS || board.length === 0 || s.hero === null) return null;
    const hero = s.hero;
    let sum = 0;
    for (const opponent of field) {
      const info = toBattleInfo(
        {
          turn: s.turn,
          playerBoard: board,
          playerHand: hand,
          opponentBoard: opponent.board,
          playerHero: hero,
          techLevel: s.techLevel,
          anomalyCardId: s.anomalyCardId,
          globalInfo: s.globalInfo,
          playerDeity: s.deity,
          playerTrinketDbfIds: s.playerId === null ? [] : (s.trinketsByPlayer[s.playerId] ?? []),
          opponentTrinketDbfIds: opponent.trinketDbfIds,
          opponentDeity: opponent.deity ?? null,
        },
        sims,
      );
      sum += withSeededRandom(SEED, () => {
        const r = simulator.run(info, sims);
        return r.wonPercent + r.tiedPercent / 2;
      });
    }
    return sum / field.length;
  };

  const rows: { part: number; turn: number; delta: number | null; before: string; after: string }[] = [];
  for (const a of after) {
    const b = byKey.get(key(a));
    if (b === undefined || JSON.stringify(a.steps) === JSON.stringify(b.steps)) continue;
    const s = stateOf(a.part, a.turn);
    if (s === undefined) continue;
    const pb = percent(s, a.part, applyWideBuffs(cards, s, b), b.finalHand);
    const pa = percent(s, a.part, applyWideBuffs(cards, s, a), a.finalHand);
    rows.push({
      part: a.part,
      turn: a.turn,
      delta: pa === null || pb === null ? null : pa - pb,
      before: b.steps.join(' → '),
      after: a.steps.join(' → '),
    });
  }

  console.log(`точек: ${String(after.length)}; план разошёлся в ${String(rows.length)}`);
  for (const r of rows) {
    const d = r.delta === null ? 'поля нет' : `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(2)} п.п.`;
    console.log(`\npart${String(r.part)} ход ${String(r.turn)}: ${d}`);
    console.log(`   ДО:    ${r.before}`);
    console.log(`   ПОСЛЕ: ${r.after}`);
  }

  const measured = rows.filter((r): r is typeof r & { delta: number } => r.delta !== null);
  if (measured.length === 0) {
    console.log('\nизмерено 0 точек');
    return;
  }
  const parts = [...new Set(measured.map((r) => r.part))];
  const means = parts.map((p) => {
    const d = measured.filter((r) => r.part === p).map((r) => r.delta);
    return d.reduce((x, y) => x + y, 0) / d.length;
  });
  const mean = means.reduce((x, y) => x + y, 0) / means.length;
  const sd = Math.sqrt(means.reduce((x, y) => x + (y - mean) ** 2, 0) / Math.max(1, means.length - 1));
  console.log(
    `\nизмерено ${String(measured.length)} точек ${String(parts.length)} партий: ` +
      `${mean.toFixed(2)} ± ${(sd / Math.sqrt(means.length)).toFixed(2)} п.п. по партиям (SE), ` +
      `лучше ${String(measured.filter((r) => r.delta > 0.25).length)}, ` +
      `хуже ${String(measured.filter((r) => r.delta < -0.25).length)}`,
  );
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'dump' && rest[0] !== undefined) {
    const listed = rest.slice(1).map(Number);
    const parts: number[] = [];
    if (listed.length > 0) parts.push(...listed);
    else for (let p = 4; fixtureLogPaths(p).length > 0; p++) parts.push(p);
    dump(rest[0], parts);
  } else if (command === 'compare' && rest[0] !== undefined && rest[1] !== undefined) {
    compare(rest[0], rest[1], Number(rest[2] ?? '200'));
  } else {
    console.log('dump <out.json> [part…] | compare <before.json> <after.json> [симуляций]');
  }
}

main();
