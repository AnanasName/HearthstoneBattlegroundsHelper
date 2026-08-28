import { createRequire } from 'node:module';

/**
 * Версия приложения — из package.json, одна на терминал, трей и архив.
 *
 * Не `app.getVersion()`: та есть только под Electron, а версию пишет
 * в метаданные сессий и сборщик из терминала. `../../package.json`
 * лежит на одной глубине от `src/app` и `dist/app`; в сборке
 * electron-builder кладёт package.json в корень приложения.
 */
const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

export const APP_VERSION: string = version;
