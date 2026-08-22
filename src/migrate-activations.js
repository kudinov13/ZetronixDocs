/**
 * Миграция: добавляет max_activations (лимит устройств на один ключ)
 */
const { Pool } = require('pg')
require('dotenv').config()

async function migrate() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'zetronixdocs',
    user: process.env.DB_USER || 'zetronix',
    password: process.env.DB_PASSWORD || 'zetronix_password',
  })

  console.log('Миграция: лимит активаций...')

  await pool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS max_activations INTEGER DEFAULT 1`)
  console.log('  ✓ Поле max_activations')

  // Установить существующим лицензиям значение 1 (если NULL)
  await pool.query(`UPDATE licenses SET max_activations = 1 WHERE max_activations IS NULL`)
  console.log('  ✓ Значения по умолчанию')

  console.log('\n✅ Готово.')
  await pool.end()
}

migrate().catch(err => { console.error('❌', err.message); process.exit(1) })
