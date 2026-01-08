const pg = require('pg');
const bcrypt = require('bcrypt');

(async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  // GANTI password ini setelah deploy (atau set via env)
  const adminUser = 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'Admin#1234';

  const superUser = 'superadmin';
  const superPass = process.env.SUPERADMIN_PASSWORD || 'Super#1234';

  const aHash = await bcrypt.hash(adminPass, 10);
  const sHash = await bcrypt.hash(superPass, 10);

  await pool.query(
    `INSERT INTO users(username,password_hash,role)
     VALUES ($1,$2,'admin')
     ON CONFLICT (username) DO NOTHING`,
    [adminUser, aHash]
  );

  await pool.query(
    `INSERT INTO users(username,password_hash,role)
     VALUES ($1,$2,'superadmin')
     ON CONFLICT (username) DO NOTHING`,
    [superUser, sHash]
  );

  console.log('Users ensured: admin + superadmin');
  console.log(`admin password: ${adminPass}`);
  console.log(`superadmin password: ${superPass}`);

  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
