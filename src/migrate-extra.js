/**
 * Дополнительная миграция: поля для админ-панели.
 * Добавляет customer_type, price_rubles, ai_budget_rubles в таблицу licenses.
 */

const { Pool } = require('pg')
require('dotenv').config()

async function migrateExtra() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'zetronixdocs',
    user: process.env.DB_USER || 'zetronix',
    password: process.env.DB_PASSWORD || 'zetronix_password',
  })

  console.log('Дополнительная миграция: поля админ-панели...')

  // Тип клиента: individual (ИП), small (малая организация), large (крупная)
  await pool.query(`
    ALTER TABLE licenses ADD COLUMN IF NOT EXISTS customer_type VARCHAR(20) DEFAULT 'small'
  `)
  console.log('  ✓ Поле customer_type')

  // Цена подписки в рублях (сколько клиент заплатил)
  await pool.query(`
    ALTER TABLE licenses ADD COLUMN IF NOT EXISTS price_rubles NUMERIC(10, 2) DEFAULT 0
  `)
  console.log('  ✓ Поле price_rubles')

  // Бюджет на ИИ в рублях (сколько мы выделяем клиенту на токены)
  await pool.query(`
    ALTER TABLE licenses ADD COLUMN IF NOT EXISTS ai_budget_rubles NUMERIC(10, 2) DEFAULT 0
  `)
  console.log('  ✓ Поле ai_budget_rubles')

  // Примечание (комментарий администратора)
  await pool.query(`
    ALTER TABLE licenses ADD COLUMN IF NOT EXISTS admin_note TEXT DEFAULT ''
  `)
  console.log('  ✓ Поле admin_note')

  console.log('\n✅ Дополнительная миграция завершена.')
  await pool.end()
}

migrateExtra().catch((err) => {
  console.error('❌ Ошибка:', err.message)
  process.exit(1)
})
