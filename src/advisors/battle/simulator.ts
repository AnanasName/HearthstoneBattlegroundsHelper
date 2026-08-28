/**
 * Общий рантайм симулятора: загрузка карт и прогон боя.
 *
 * До фазы 3 эти двадцать строк были скопированы в спайк, калибровку и тест —
 * терпимо, пока вызовов было три. Советник расстановки дёргает симулятор
 * тысячи раз за один совет, и там уже важно, какие именно опции передаются:
 * умолчания пакета дороже, чем кажется (см. RUN_OPTIONS).
 */
import { readFileSync } from 'node:fs';

import { AllCardsService } from '@firestone-hs/reference-data';
import { simulateBattle } from '@firestone-hs/simulate-bgs-battle';
import type { BgsBattleInfo } from '@firestone-hs/simulate-bgs-battle/dist/bgs-battle-info.js';
import type { BgsBattleOptions } from '@firestone-hs/simulate-bgs-battle/dist/bgs-battle-options.js';
import { CardsData } from '@firestone-hs/simulate-bgs-battle/dist/cards/cards-data.js';
import type { SimulationResult } from '@firestone-hs/simulate-bgs-battle/dist/simulation-result.js';

import { CARDS_PATH } from '../../app/paths.js';

export { CARDS_PATH };

/**
 * Опции, которые стоит задавать всегда, — умолчания пакета для нас плохи.
 *
 * `includeOutcomeSamples` по умолчанию `true`, и после основного цикла пакет
 * доигрывает бой заново с включённой записью действий, чтобы приложить по
 * образцу на каждый исход. Нам образцы не нужны ни в калибровке, ни в поиске
 * расстановки, а платить за них приходится на каждом вызове.
 *
 * `intermediateResults` по умолчанию 200: генератор отдаёт промежуточный итог
 * каждые двести симуляций, пересчитывая при этом перцентили урона сортировкой.
 * Ноль выключает промежуточные выдачи целиком.
 *
 * `maxAcceptableDuration` по умолчанию 8000 мс, и по его истечении пакет
 * молча обрывает цикл, отдав результат по неполному числу симуляций. Для
 * перебора расстановок это означало бы, что часть кандидатов оценена хуже
 * остальных без всякого предупреждения.
 */
const RUN_OPTIONS: Omit<BgsBattleOptions, 'numberOfSimulations'> = {
  skipInfoLogs: true,
  includeOutcomeSamples: false,
  intermediateResults: 0,
  hideMaxSimulationDurationWarning: true,
  maxAcceptableDuration: 60_000,
};

/** Достроить вход боя опциями прогона, не трогая всё остальное. */
export function withRunOptions(input: BgsBattleInfo, numberOfSimulations?: number): BgsBattleInfo {
  return {
    ...input,
    options: {
      ...input.options,
      ...RUN_OPTIONS,
      ...(numberOfSimulations === undefined ? {} : { numberOfSimulations }),
    },
  };
}

export interface BattleSimulator {
  readonly cards: AllCardsService;
  readonly cardsData: CardsData;
  /** Прогон боя до конца. Число симуляций берётся из входа, если не задано. */
  readonly run: (input: BgsBattleInfo, numberOfSimulations?: number) => SimulationResult;
}

/**
 * Снапшот карт с диска, без сети.
 *
 * Отдельно от `createBattleSimulator` затем, что спайк фазы 2 меряет сам пакет
 * с его умолчаниями и собственным прогоном — карты ему нужны, а наши опции нет.
 */
export function loadCards(cardsPath: string = CARDS_PATH): {
  cards: AllCardsService;
  cardsData: CardsData;
} {
  const cards = new AllCardsService();
  cards.initializeCardsDbFromCards(JSON.parse(readFileSync(cardsPath, 'utf8')) as never);
  const cardsData = new CardsData(cards, false);
  cardsData.inititialize();
  return { cards, cardsData };
}

export function createBattleSimulator(cardsPath: string = CARDS_PATH): BattleSimulator {
  const { cards, cardsData } = loadCards(cardsPath);

  const run = (input: BgsBattleInfo, numberOfSimulations?: number): SimulationResult => {
    const generator = simulateBattle(withRunOptions(input, numberOfSimulations), cards, cardsData);
    let step = generator.next();
    while (step.done !== true) step = generator.next();
    return step.value;
  };

  return { cards, cardsData, run };
}

/**
 * Ленивый синглтон.
 *
 * Снапшот карт — 38 МБ JSON, его разбор занимает секунды и держит память.
 * Второй экземпляр в том же процессе не нужен никому, а в тестах на несколько
 * файлов набегает заметно.
 */
let shared: BattleSimulator | null = null;

export function sharedBattleSimulator(): BattleSimulator {
  shared ??= createBattleSimulator();
  return shared;
}
