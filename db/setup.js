// Build the Chat App database inside CockroachDB.
// Reads DATABASE_URL (from examhub.env or the environment), connects to
// CockroachDB, and applies schema.sql. Safe to re-run (uses IF NOT EXISTS).
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function loadEnv(file) {
  const raw = fs.readFileSync(file, 'utf8');
  raw.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^([^#=]+)=\"?([^\"]*)\"?$/);
    if (m) process.env[m[1].trim()] = m[2];
  });
}

function loadEnvFile() {
  const candidates = [
    path.join(__dirname, '..', 'examhub.env'),
    path.join(__dirname, '..', '.env'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      loadEnv(file);
      console.log(`Loaded environment from ${file}`);
      return;
    }
  }
}

async function main() {
  loadEnvFile();

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Add examhub.env or .env with DATABASE_URL.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    console.log('Connected to CockroachDB.');

    const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    await client.query(schema);
    console.log('Schema applied successfully.');

    // Ensure the default Lobby room exists.
    await client.query("INSERT INTO rooms (name) VALUES ('Lobby') ON CONFLICT (name) DO NOTHING");
    console.log('Default "Lobby" room ensured.');

    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`
    );
    console.log('Tables in database:', tables.rows.map((r) => r.table_name).join(', '));
  } catch (err) {
    console.error('Failed to apply schema:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
