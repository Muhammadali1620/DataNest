import { createConnection } from 'node:net';
import { testDatabase, type TestDatabaseId } from './databases';

const IDS: TestDatabaseId[] = ['mysql', 'mariadb', 'postgres'];

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 1000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Vitest global setup: fail fast with a clear hint when the databases are not running. */
export async function setup(): Promise<void> {
  const down: string[] = [];
  for (const id of IDS) {
    const db = testDatabase(id);
    if (!(await canConnect(db.host, db.port))) {
      down.push(`${id} (${db.host}:${db.port})`);
    }
  }
  if (down.length > 0) {
    const error = new Error(
      `Test databases are not reachable: ${down.join(', ')}. Run "npm run db:up".`,
    );
    // Vitest crashes while source-mapping stack frames of global setup errors,
    // which hides this message; a frameless stack avoids that.
    error.stack = `Error: ${error.message}`;
    throw error;
  }
}
