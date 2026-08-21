/**
 * Миграция базы данных PostgreSQL.
 * Создаёт таблицы для лицензий, активаций и отчётов по токенам.
 * Запуск: npm run migrate
 */

const { Pool } = require('pg')
require('dotenv').config()

async function migrate() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'ZetronixDocs',
    user: process.env.DB_USER || 'Zetronix',
    password: process.env.DB_PASSWORD || 'zenza_password',
  })

  console.log('Миграция базы данных ZetronixDocs...')

  // Таблица лицензий
  await pool.query(`
    CREATE TABLE IF NOT EXISTS licenses (
      id SERIAL PRIMARY KEY,
      key_id VARCHAR(32) UNIQUE NOT NULL,
      customer VARCHAR(500) NOT NULL,
      plan VARCHAR(20) NOT NULL,
      expiry_date TIMESTAMP NULL,
      unlimited BOOLEAN DEFAULT FALSE,
      token_limit INTEGER DEFAULT 0,
      issued_at TIMESTAMP NOT NULL,
      license_key TEXT NOT NULL,
      revoked BOOLEAN DEFAULT FALSE,
      revoked_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)
  console.log('  ✓ Таблица licenses')

  // Таблица активаций
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activations (
      id SERIAL PRIMARY KEY,
      license_id INTEGER REFERENCES licenses(id) ON DELETE CASCADE,
      key_id VARCHAR(32) NOT NULL,
      machine_id VARCHAR(255) NOT NULL,
      customer VARCHAR(500) NOT NULL,
      activated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(key_id, machine_id)
    )
  `)
  console.log('  ✓ Таблица activations')

  // Таблица использования токенов
  await pool.query(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id SERIAL PRIMARY KEY,
      license_id INTEGER REFERENCES licenses(id) ON DELETE CASCADE,
      key_id VARCHAR(32) NOT NULL,
      customer VARCHAR(500) NOT NULL,
      machine_id VARCHAR(255),
      tokens_used BIGINT NOT NULL,
      cost_rubles NUMERIC(10, 2) NOT NULL,
      document_type VARCHAR(100),
      recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)
  console.log('  ✓ Таблица token_usage')

  // Индексы для отчётов
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_usage_key_id ON token_usage(key_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_usage_recorded_at ON token_usage(recorded_at)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_usage_customer ON token_usage(customer)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_licenses_customer ON licenses(customer)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_licenses_plan ON licenses(plan)`)

  console.log('  ✓ Индексы созданы')
  console.log('\n✅ Миграция завершена успешно.')

  await pool.end()
}

migrate().catch((err) => {
  console.error('❌ Ошибка миграции:', err.message)
  console.error('\nУбедитесь, что:')
  console.error('  1. PostgreSQL установлен и запущен')
  console.error('  2. База данных "ZetronixDocs" создана')
  console.error('  3. Параметры подключения в .env корректны')
  console.error('\nСоздание базы данных:')
  console.error('  psql -U postgres -c "CREATE DATABASE ZetronixDocs;"')
  console.error('  psql -U postgres -c "CREATE USER zenza WITH PASSWORD \'zenza_password\';"')
  console.error('  psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE ZetronixDocs TO zenza;"')
  process.exit(1)
})
