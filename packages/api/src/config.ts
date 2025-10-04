export interface Config {
  port: number;
  databaseUrl: string;
}

function env(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value !== undefined) return value;
  if (defaultValue !== undefined) return defaultValue;
  throw new Error(`Missing: ${key}`);
}

export const config: Config = {
  port: parseInt(process.env.PORT || '3000', 10),
  databaseUrl: env('DATABASE_URL', 'postgresql://localhost:5432/crawlee'),
};
