import { BaseDatabase, DatabaseConfig } from '@secondlayer/shared';
import type { IDatabase } from '../domain/ports/index.js';

export class Database extends BaseDatabase implements IDatabase {
  constructor(config?: DatabaseConfig) {
    super(config ?? {
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432'),
      user: process.env.POSTGRES_USER || 'secondlayer',
      password: process.env.POSTGRES_PASSWORD || 'secondlayer_password',
      database: process.env.POSTGRES_DB || 'secondlayer_db',
    });
  }
}

/**
 * Read pool for legal content (legislation, EDRSR court decisions, editions).
 *
 * On environments where the content lives in a different database than the
 * app state (e.g. dev reads prod content via a read-only tunnel user), set
 * CONTENT_DATABASE_URL and content services get this pool while app-state
 * writes (sessions, billing, cost tracking) stay on the main Database.
 * When the variable is unset, callers fall back to the main pool — prod and
 * local behaviour is unchanged.
 */
export class ContentDatabase extends Database {
  constructor(connectionUrl: string) {
    const url = new URL(connectionUrl);
    super({
      host: url.hostname,
      port: parseInt(url.port || '5432'),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ''),
      // Content reads only — keep the pool small; the main pool handles app load.
      max: 20,
    });
  }
}
