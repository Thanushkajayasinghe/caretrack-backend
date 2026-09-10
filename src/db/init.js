import pg from 'pg';

async function initDB() {
  const rootClient = new pg.Client({
    connectionString: 'postgresql://postgres:123456@localhost:5432/postgres',
  });

  await rootClient.connect();
  const res = await rootClient.query("SELECT 1 FROM pg_database WHERE datname='caretrack'");
  if (res.rows.length === 0) {
    await rootClient.query('CREATE DATABASE caretrack');
    console.log('✅ Created database "caretrack"');
  } else {
    console.log('✅ Database "caretrack" already exists');
  }
  await rootClient.end();

  // Test caretrack db connection
  const appClient = new pg.Client({
    connectionString: 'postgresql://postgres:123456@localhost:5432/caretrack',
  });
  await appClient.connect();
  console.log('✅ Connected to "caretrack" database');
  await appClient.end();
}

initDB().catch(err => {
  console.error('Init DB error:', err.message);
  process.exit(1);
});
