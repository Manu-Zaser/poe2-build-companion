import { createLogger } from '@poe2/core/log';

/** Log file in the user data folder (for support), plus the console in development – via @poe2/core. */
const logger = createLogger({ fileName: 'companion.log' });

export function log(message: string) {
  logger.info(message);
}
