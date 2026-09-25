/**
 * Замер: делает ли прогноз боя точнее счётчик заклинаний таверны, выведенный
 * из числа на Faceless Converter?
 *
 *   npm run spike:converter
 *   npm run spike:converter -- --parts=64-76      подмножество
 *   npm run spike:converter -- --seed=7
 *
 * ## Зачем
 *
 * part76, финальный бой (ход 32): симулятор давал 84 % побед, бой проигран
 * и партия кончилась. У соперника Божество К'Тун, и его кормил хрип золотого
 * Faceless Converter `BG36_318_G` («Give your Deity +{0}/+{1}. Improved by
 * each Tavern spell you've cast this game!») — трижды через золотого Titus,
 * по +404 (game.log:453357). Число хрипа лежит на самой карте,
 * `TAG_SCRIPT_DATA_NUM_1 = 404` (game.log:450693), но пакет его не читает,
 * а считает `mult × 2 × (1 + globalInfo.TavernSpellsCastThisGame)`. Это поле
 * маппер не передаёт ни одной стороне: у соперника тега нет вовсе, а свой
 * `NUM_SPELLS_PLAYED_THIS_GAME` уходит в соседнее `SpellsCastThisGame`.
 * Симулятор давал Божеству +4 за хрип; с числом карты — 50.5 % побед.
 *
 * Правка — перевести число карты в счётчик стороны. Но бой один — не замер,
 * и первый прогон (25.09) правку не поддержал. Игрок решил ждать боёв
 * (25.09, [журнал j-0925-4](../../../docs/journal.md#j-0925-4)); этот
 * скрипт — чтобы «подождать» стоило одной команды.
 *
 * ## Что выяснилось о самом числе — до замера
 *
 *  - золотая и обычная карта на одном столе дают одно основание (part74:
 *    288 и 144; part68: 82 и 82) — число = кратность × основание;
 *  - основание бывает НЕЧЁТНЫМ (23 в part65 и part67), то есть формула игры
 *    не формула пакета, и счётчик выводится дробным: `N = число / (2 × mult) − 1`,
 *    чтобы пакет выдал ровно число карты;
 *  - свой тег за N не годится: у своей карты в part71 N = 46 и 61 при
 *    `NUM_SPELLS_PLAYED_THIS_GAME` 26 и 29.
 *
 * ## Предрегистрация — объявлено 25.09, ДО новых боёв
 *
 * **Точки.** Все бои партий с part64 (первая с картой), где Faceless Converter
 * стоит на столе у любой стороны и несёт `TAG_SCRIPT_DATA_NUM_1`. part66
 * исключена: в её папке брошенный неразмеченный лог (data/fixtures/CLAUDE.md).
 *
 * **Мера.** Средний квадрат ошибки вероятности ФАКТИЧЕСКОГО исхода,
 * `(1 − P(факт))²`, 1000 симуляций на бой, зерно `--seed` — та же, что
 * у проверки Божества (D287). Две ветви на одном и том же бое: без счётчика
 * (как сейчас) и со счётчиком из числа карты у той стороны, где карта стоит.
 *
 * **Приёмка — оба условия:**
 *  1. боёв не меньше 58 — вдвое больше первого прогона: на 29 боях половина
 *     точек стоит на 100 % в обеих ветвях и ничего не различает;
 *  2. ошибка со счётчиком НЕ БОЛЬШЕ, чем без него. Порог «не хуже», а не
 *     «лучше», потому что правка — верность входа, а не новая эвристика:
 *     число берётся из лога и в part76 совпало с боем до единицы
 *     (прецедент — горизонт партии, внесённый при нулевом эффекте, j-0922-6).
 *
 * **Первый прогон, 25.09:** 29 боёв part64–part76, 0.091 → 0.096 — не принято
 * по обоим условиям. Весь чистый минус дал один бой: part64 ход 20
 * (71 → 29 %, бой выигран).
 *
 * ## Чего замер НЕ докажет
 *
 * Пользы в живой игре: карту соперника видно только в бою, и совет
 * расстановки против неё — редкость. Мерится честность прогноза боя
 * (калибровка, отчёт после партии), а не сила советов.
 */
import { partsArg, seedArg } from '../../measure/args.js';
import { readFixtureGame } from '../../data/fixtureGames.js';
import type { Minion } from '../../state/types.js';
import { readBattleEpisodes, type BattleEpisode } from './episodes.js';
import { toBattleInfo } from './mapper.js';
import { seededSimulator } from './seeded.js';
import { createBattleSimulator } from './simulator.js';

const FIRST_PART = 64;
const ABANDONED_PARTS = new Set([66]);
const SIMULATIONS = 1000;
const MIN_BATTLES = 58;

/** Партии с part64, у которых есть лог, кроме брошенных. */
function availableParts(): number[] {
  const parts: number[] = [];
  for (let part = FIRST_PART, misses = 0; misses < 5; part += 1) {
    if (ABANDONED_PARTS.has(part)) continue;
    if (readFixtureGame(part) === null) {
      misses += 1;
      continue;
    }
    misses = 0;
    parts.push(part);
  }
  return parts;
}

function isConverter(m: Minion): boolean {
  return m.cardId === 'BG36_318' || m.cardId === 'BG36_318_G';
}

/**
 * Счётчик, при котором пакет выдаст ровно число карты; `null` — карты
 * с числом на столе нет. Несколько карт одной стороны дают одно основание,
 * поэтому берётся любая, наибольшая — на случай расхождения.
 */
function converterSpellCount(board: readonly Minion[]): number | null {
  const counts = board.filter(isConverter).flatMap((m) => {
    const amount = m.scriptData[0];
    if (amount === null || amount === undefined) return [];
    const mult = m.golden || m.cardId.endsWith('_G') ? 2 : 1;
    return [amount / (2 * mult) - 1];
  });
  return counts.length === 0 ? null : Math.max(...counts);
}

function withSpellCount(info: ReturnType<typeof toBattleInfo>, own: number | null, opponent: number | null) {
  if (own !== null) info.playerBoard.player.globalInfo = { ...info.playerBoard.player.globalInfo, TavernSpellsCastThisGame: own };
  if (opponent !== null) {
    info.opponentBoard.player.globalInfo = { ...info.opponentBoard.player.globalInfo, TavernSpellsCastThisGame: opponent };
  }
  return info;
}

function factProbability(episode: BattleEpisode, percent: { won: number; lost: number; tied: number }): number {
  const p = episode.outcome === 'won' ? percent.won : episode.outcome === 'lost' ? percent.lost : percent.tied;
  return p / 100;
}

function main(): void {
  const argv = process.argv.slice(2);
  const parts = partsArg(argv, availableParts());
  const simulator = seededSimulator(createBattleSimulator(), seedArg(argv));

  let before = 0;
  let after = 0;
  let battles = 0;
  for (const part of parts) {
    const text = readFixtureGame(part);
    if (text === null) continue;
    for (const episode of readBattleEpisodes(text)) {
      const own = converterSpellCount(episode.playerBoard);
      const opponent = converterSpellCount(episode.opponentBoard);
      if (own === null && opponent === null) continue;

      const run = (info: ReturnType<typeof toBattleInfo>) => {
        const r = simulator.run(info);
        return factProbability(episode, { won: r.wonPercent, lost: r.lostPercent, tied: r.tiedPercent });
      };
      const without = run(toBattleInfo(episode, SIMULATIONS));
      const withCount = run(withSpellCount(toBattleInfo(episode, SIMULATIONS), own, opponent));
      before += (1 - without) ** 2;
      after += (1 - withCount) ** 2;
      battles += 1;
      console.log(
        `part${String(part)} ход ${String(episode.turn)} ${episode.outcome}: ` +
          `N свой ${own === null ? '—' : own.toFixed(1)}, соперника ${opponent === null ? '—' : opponent.toFixed(1)} · ` +
          `P(факт) ${(without * 100).toFixed(1)} → ${(withCount * 100).toFixed(1)} %`,
      );
    }
  }

  if (battles === 0) {
    console.log('боёв с Faceless Converter нет');
    return;
  }
  const mseBefore = before / battles;
  const mseAfter = after / battles;
  console.log(`\nбоёв ${String(battles)}; средний квадрат ошибки P(факт): ${mseBefore.toFixed(3)} → ${mseAfter.toFixed(3)}`);
  const enough = battles >= MIN_BATTLES;
  const notWorse = mseAfter <= mseBefore;
  console.log(
    `приёмка: боёв ≥ ${String(MIN_BATTLES)} — ${enough ? 'да' : 'нет'}; ошибка не хуже — ${notWorse ? 'да' : 'нет'} → ` +
      (enough && notWorse ? 'ВНОСИТЬ' : 'не вносить'),
  );
}

main();
