/**
 * Миграция для AI Proxy: таблицы для ключей, клиентских машин и конфига.
 * Запуск: node src/migrate-ai-proxy.js
 */

const { Pool } = require('pg')
require('dotenv').config()

async function migrateAiProxy() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'ZetronixDocs',
    user: process.env.DB_USER || 'Zetronix',
    password: process.env.DB_PASSWORD || 'zenza_password',
  })

  console.log('Миграция AI Proxy...')

  // ─── API ключи провайдеров ───
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_providers (
      id SERIAL PRIMARY KEY,
      provider VARCHAR(50) NOT NULL,
      label VARCHAR(100) NOT NULL,
      api_key TEXT NOT NULL,
      endpoint VARCHAR(500) NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_providers_provider_label ON ai_providers(provider, label)
  `)
  console.log('  ✓ Таблица ai_providers')

  // ─── Клиентские машины (с rate limits) ───
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_machines (
      id SERIAL PRIMARY KEY,
      machine_id VARCHAR(255) NOT NULL,
      hostname VARCHAR(255),
      local_ip VARCHAR(45),
      key_id VARCHAR(32),
      customer VARCHAR(500),
      rate_limit_rpm INTEGER DEFAULT 10,
      ocr_provider VARCHAR(50) DEFAULT 'auto',
      last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(machine_id)
    )
  `)
  console.log('  ✓ Таблица client_machines')

  // ─── Глобальный конфиг приложения ───
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_config (
      id SERIAL PRIMARY KEY,
      key VARCHAR(100) UNIQUE NOT NULL,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)
  console.log('  ✓ Таблица app_config')

  // ─── Дефолтные значения конфига ───
  const defaults = [
    ['ocr_provider', 'tsar'],
    ['ocr_endpoint', 'https://api.tsarrouter.ru/v1'],
    ['ocr_model', 'yandex/ocr-markdown'],
    ['repair_ocr_model', 'deepseek-ai/DeepSeek-OCR-2'],
    ['gigachat_endpoint', 'https://api.giga.chat/v1'],
    ['gigachat_oauth_url', 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth'],
    ['gigachat_model', 'GigaChat-2'],
    ['mistral_provider', 'direct'],
    ['mistral_endpoint', 'https://api.mistral.ai/v1'],
    ['routerai_endpoint', 'https://routerai.ru/api/v1'],
    ['global_rate_limit_rpm', '12'],
    ['app_version', '1.0.0'],
    ['min_required_version', '1.0.0'],
    ['force_update', 'false'],
    ['update_url', ''],
    ['proxy_enabled', 'true'],
  ]

  for (const [key, value] of defaults) {
    await pool.query(`
      INSERT INTO app_config (key, value)
      VALUES ($1, $2)
      ON CONFLICT (key) DO NOTHING
    `, [key, value])
  }
  console.log('  ✓ Дефолтный конфиг загружен')

  // ─── Индексы ───
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_client_machines_machine_id ON client_machines(machine_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_client_machines_key_id ON client_machines(key_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_providers_provider ON ai_providers(provider)`)

  console.log('  ✓ Индексы созданы')
  console.log('\n✅ Миграция AI Proxy завершена.')

  await pool.end()
}

migrateAiProxy().catch((err) => {
  console.error('❌ Ошибка миграции AI Proxy:', err.message)
  process.exit(1)
})
