import { formatReport, importArchive } from './import.js';

/**
 * Приём архива логов от исполнителя — или своего.
 *
 *   npm run dataset:import -- <путь к hsbg-logs_….tar> [--from <псевдоним>] [--rating <число>]
 *   npm run dataset:import -- <путь к hsbg-logs_….tar> --own
 *
 * Без `--from` псевдоним — BattleTag игрока из лога. Рейтинг в логе
 * не пишется, его исполнитель называет словами вместе с архивом.
 * `--own` — архив собран установленным приложением на своей машине:
 * записи ложатся как свои, без пометки исполнителя.
 */
function main(): void {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const tarPath = argv.find((a) => !a.startsWith('--') && a !== get('from') && a !== get('rating'));
  if (tarPath === undefined) {
    console.log('укажите архив: npm run dataset:import -- <файл.tar> [--from <псевдоним>] [--rating <число>]');
    process.exitCode = 1;
    return;
  }

  const ratingRaw = get('rating');
  const rating = ratingRaw === undefined ? null : Number(ratingRaw);
  const report = importArchive(tarPath, {
    alias: get('from') ?? null,
    rating: rating !== null && Number.isFinite(rating) ? rating : null,
    own: argv.includes('--own'),
  });
  console.log(formatReport(report));
}

main();
