/**
 * Обновление снапшота карт.
 *
 *   npm run update:cards
 *
 * Единственное место во всём проекте, где есть сеть, и только по явной команде —
 * так требует ТЗ. В рантайме снапшот берётся с диска.
 *
 * Зачем это нужно вообще: набор карт меняется с каждым патчем Battlegrounds,
 * и незнакомая карта — это не «немного хуже совет», а совет вслепую. Проверено
 * на партии от 13.08.2026 (билд 248348): снапшот от 04.08 не знал 41 карту
 * из 216 встретившихся, почти все — новый набор BG36.
 */
import { writeFileSync } from 'node:fs';

import { CARDS_PATH, loadCardIndex } from './cards.js';

const SOURCE = 'https://static.zerotoheroes.com/data/cards/cards_enUS.gz.json';

/** Что известно про снапшот, лежащий на диске сейчас. */
function describeCurrent(): string {
  try {
    const index = loadCardIndex();
    return `${index.size.toLocaleString('ru-RU')} карт`;
  } catch {
    return 'нет';
  }
}

async function main(): Promise<void> {
  console.log(`сейчас на диске: ${describeCurrent()}`);
  console.log(`качаю ${SOURCE}`);

  const response = await fetch(SOURCE);
  if (!response.ok) {
    throw new Error(`источник ответил ${String(response.status)}`);
  }

  const text = await response.text();
  const cards: unknown = JSON.parse(text);
  if (!Array.isArray(cards) || cards.length === 0) {
    // Записать мусор поверх рабочего снапшота хуже, чем не обновиться:
    // сломается и симулятор, и советник таверны.
    throw new Error('источник вернул не массив карт');
  }

  writeFileSync(CARDS_PATH, text, 'utf8');
  console.log(`записано ${CARDS_PATH}: ${cards.length.toLocaleString('ru-RU')} карт`);
  console.log(
    'проверьте после обновления: npm test, npm run calibrate\n' +
      'снапшот коммитится — он часть данных, а не кэш',
  );
}

void main();
