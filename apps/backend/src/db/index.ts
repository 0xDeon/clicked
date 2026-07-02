import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

const connectionString = process.env['DATABASE_URL'] || 'postgres://user:password@localhost:5432/testdb';
// No error thrown; fallback for test environment

const client = postgres(connectionString);

export const db = drizzle(client, { schema });
