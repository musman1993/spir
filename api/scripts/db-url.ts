// Reads the database URL for the npm db:* scripts and explains common setup mistakes in plain words.
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  const stop = (msg: string): never => {
    console.error(`\n${msg}\n\nOpen .env (run: code .env) and set DATABASE_URL to the connection string from\nNeon console > your SPIR project > Connect. Then run the command again.\n`);
    process.exit(1);
  };
  if (!url) return stop('DATABASE_URL is not set.');
  if (/USER:PASSWORD@HOST|@HOST\//.test(url)) return stop('DATABASE_URL in .env is still the example placeholder (USER:PASSWORD@HOST).');
  if (!/^postgres(ql)?:\/\//.test(url)) return stop('DATABASE_URL should start with postgresql://');
  return url;
}
