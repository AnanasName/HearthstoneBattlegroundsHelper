/**
 * Спайк интеграции с @firestone-hs/simulate-bgs-battle.
 *
 *   npm run spike:battle
 *
 * Отвечает на три вопроса, которые надо было закрыть до начала фазы 2:
 *   1. заводится ли симулятор на локальном снапшоте карт, без сети;
 *   2. покрывает ли снапшот карты из наших фикстур;
 *   3. какая реальная производительность — от неё зависит выполнимость фаз 2 и 3.
 *
 * Скрипт оставлен в репозитории намеренно: замеры надо перепроверять при
 * обновлении симулятора, а не доверять числам, записанным однажды в документацию.
 */
import type { AllCardsService } from '@firestone-hs/reference-data';
import { simulateBattle } from '@firestone-hs/simulate-bgs-battle';
// Пакет не объявляет карту exports, а точка входа реэкспортирует только
// simulateBattle. Типы приходится брать глубокими импортами, и под NodeNext
// они обязаны нести расширение .js — иначе tsc их не находит, хотя tsx
// резолвит и код при этом работает.
import type { BgsBattleInfo } from '@firestone-hs/simulate-bgs-battle/dist/bgs-battle-info.js';
import type { BgsPlayerEntity } from '@firestone-hs/simulate-bgs-battle/dist/bgs-player-entity.js';
import type { BoardEntity } from '@firestone-hs/simulate-bgs-battle/dist/board-entity.js';
import type { CardsData } from '@firestone-hs/simulate-bgs-battle/dist/cards/cards-data.js';
import type { SimulationResult } from '@firestone-hs/simulate-bgs-battle/dist/simulation-result.js';

import { loadCards } from './simulator.js';

/** Минимальный герой: только обязательные поля BgsPlayerEntity. */
function hero(cardId: string, hpLeft: number, tavernTier: number): BgsPlayerEntity {
  return { cardId, hpLeft, tavernTier, heroPowers: [], questEntities: [] };
}

function minion(entityId: number, cardId: string, attack: number, health: number): BoardEntity {
  // Остальные поля BoardEntity опциональны — минимального набора хватает,
  // чтобы симулятор отработал. Что стоит добавить, перечислено в docs/simulator.md.
  return { entityId, cardId, attack, health };
}

/**
 * Прогон с умолчаниями пакета, а не с нашими опциями.
 *
 * Намеренно: этот спайк отвечает на вопрос «что представляет собой пакет как
 * он есть». Числа под наши настройки — в `npm run spike:position`.
 */
function run(
  input: BgsBattleInfo,
  cards: AllCardsService,
  cardsData: CardsData,
): SimulationResult {
  const generator = simulateBattle(input, cards, cardsData);
  let step = generator.next();
  while (step.done !== true) step = generator.next();
  return step.value;
}

function main(): void {
  // ─── 1. загрузка карт без сети ─────────────────────────────────────────────
  const started = Date.now();
  const { cards, cardsData } = loadCards();
  const all = cards.getCards();
  console.log(
    `карты: ${all.length.toLocaleString('ru-RU')} штук за ${String(Date.now() - started)} мс, из файла`,
  );
  console.log(
    `  миньонов BG (есть techLevel): ${String(all.filter((c) => c.techLevel !== undefined).length)}` +
      `, золотых (_G): ${String(all.filter((c) => c.id.endsWith('_G')).length)}`,
  );

  // ─── 2. покрытие карт из фикстур ───────────────────────────────────────────
  console.log('\n=== карты из фикстур ===');
  const fromFixtures = [
    'BG31_815',
    'BG31_815_G',
    'BGS_126',
    'TB_BaconShop_HERO_60',
    'TB_BaconShop_HERO_70_SKIN_H',
    'BG27_Anomaly_301',
    'BG27_Anomaly_303',
  ];
  let missing = 0;
  for (const id of fromFixtures) {
    const c = cards.getCard(id, false);
    if (c.id === undefined) {
      missing += 1;
      console.log(`  ${id.padEnd(30)} НЕ НАЙДЕНА`);
    } else {
      console.log(`  ${id.padEnd(30)} ${c.name ?? ''}`);
    }
  }
  console.log(missing === 0 ? '  все найдены' : `  отсутствует: ${String(missing)}`);

  // ─── 3. пример боя из фикстуры part3, ход 7 ────────────────────────────────
  const example: BgsBattleInfo = {
    playerBoard: {
      player: hero('TB_BaconShop_HERO_60', 30, 4),
      board: [
        minion(1001, 'BG26_529', 1, 1),
        minion(1002, 'BG31_818', 4, 5),
        minion(1003, 'BG31_815', 3, 2),
      ],
    },
    opponentBoard: {
      player: hero('TB_BaconShop_HERO_02', 30, 4),
      board: [
        minion(2001, 'BG20_301', 2, 3),
        minion(2002, 'BG26_160', 5, 1),
        minion(2003, 'BG35_141', 3, 5),
      ],
    },
    options: { numberOfSimulations: 3000, skipInfoLogs: true },
    gameState: { currentTurn: 7 },
  };

  const exampleStarted = Date.now();
  const result = run(example, cards, cardsData);
  console.log(`\n=== пример боя, 3000 симуляций за ${String(Date.now() - exampleStarted)} мс ===`);
  console.log(
    `  победа ${result.wonPercent.toFixed(1)}%  ничья ${result.tiedPercent.toFixed(1)}%  ` +
      `поражение ${result.lostPercent.toFixed(1)}%`,
  );
  console.log(
    `  средний урон: нанесён ${result.averageDamageWon.toFixed(1)}, получен ${result.averageDamageLost.toFixed(1)}`,
  );

  // ─── 4. замеры на худшем случае: борд 7 на 7 ───────────────────────────────
  const bigBoard = (offset: number): BoardEntity[] =>
    Array.from({ length: 7 }, (_, i) => minion(offset + i, 'BG31_815', 3 + i, 4 + i));

  const measure = (numberOfSimulations: number): number => {
    const input: BgsBattleInfo = {
      playerBoard: { player: hero('TB_BaconShop_HERO_60', 30, 6), board: bigBoard(1000) },
      opponentBoard: { player: hero('TB_BaconShop_HERO_02', 30, 6), board: bigBoard(2000) },
      options: { numberOfSimulations, skipInfoLogs: true },
      gameState: { currentTurn: 12 },
    };
    const t = Date.now();
    run(input, cards, cardsData);
    return Date.now() - t;
  };

  console.log('\n=== замеры, борд 7 на 7 (худший случай) ===');
  let perSim = 0;
  for (const n of [300, 1000, 3000]) {
    const ms = measure(n);
    if (n === 3000) perSim = ms / n;
    console.log(`  ${String(n).padStart(4)} симуляций: ${String(ms).padStart(5)} мс`);
  }

  console.log('\n=== выполнимость по ТЗ ===');
  const budget3000 = measure(3000);
  console.log(
    `  фаза 2 (3000 симуляций ≤ 2000 мс): ${String(budget3000)} мс — ` +
      (budget3000 <= 2000 ? 'укладываемся' : 'НЕ укладываемся'),
  );
  // Оценка снизу и только снизу: здесь не учтена постоянная часть вызова
  // симулятора, а она стоит как семьдесят симуляций на каждом кандидате.
  // Настоящие числа фазы 3 меряет `npm run spike:position`.
  const full = 5040 * 300 * perSim;
  console.log(
    `  фаза 3, полный перебор 5040 x 300: не меньше ${(full / 1000).toFixed(0)} с в один поток` +
      ` (без учёта накладных на вызов, см. spike:position)`,
  );
}

main();
