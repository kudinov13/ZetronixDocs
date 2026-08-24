/**
 * Миграция для 1C маппингов: таблица для хранения схем маппинга per клиент.
 * Запуск: node src/migrate-onec.js
 */

const { Pool } = require('pg')
require('dotenv').config()

async function migrateOneC() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'ZetronixDocs',
    user: process.env.DB_USER || 'Zetronix',
    password: process.env.DB_PASSWORD || 'zenza_password',
  })

  console.log('Миграция 1C маппингов...')

  // ─── Таблица маппингов 1C ───
  await pool.query(`
    CREATE TABLE IF NOT EXISTS onec_mappings (
      id SERIAL PRIMARY KEY,
      key_id VARCHAR(32),
      customer VARCHAR(500),
      config_type VARCHAR(50) NOT NULL DEFAULT 'custom',
      config_name VARCHAR(200),
      mapping_json TEXT NOT NULL,
      schema_json TEXT,
      is_preset BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)
  console.log('  ✓ Таблица onec_mappings')

  // ─── Индексы ───
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_onec_mappings_key_id ON onec_mappings(key_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_onec_mappings_config_type ON onec_mappings(config_type)`)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_onec_mappings_key_id_unique ON onec_mappings(key_id) WHERE key_id IS NOT NULL`)

  console.log('  ✓ Индексы созданы')
  console.log('\n✅ Миграция 1C маппингов завершена.')

  await pool.end()
}

migrateOneC().catch((err) => {
  console.error('❌ Ошибка миграции 1C:', err.message)
  process.exit(1)
})
