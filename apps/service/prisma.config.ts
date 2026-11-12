import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer loads .env itself; Node's built-in loader keeps us free of dotenv.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on the environment (CI, containers).
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
