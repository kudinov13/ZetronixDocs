/**
 * ZetronixDocs Server — сервер подписок и лицензирования.
 *
 * Endpoints:
 *   POST   /api/license/activate    — активация лицензионного ключа
 *   POST   /api/usage/report        — отчёт об использовании токенов
 *   GET    /api/admin/report        — еженедельный отчёт (требует JWT)
 *   GET    /api/admin/licenses      — список всех лицензий (требует JWT)
 *   POST   /api/admin/login         — вход администратора
 *   GET    /api/health              — проверка здоровья сервера
 */

const express = require('express')
const cors = require('cors')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { Pool } = require('pg')
require('dotenv').config()

// AI Proxy module
const aiProxy = require('./ai-proxy')
// 1C Presets module
const onecPresets = require('./onec-presets')

const app = express()
const PORT = process.env.PORT || 3000
const JWT_SECRET = process.env.JWT_SECRET || 'change-this'

// Middleware
app.use(cors())
app.use(express.json({ limit: '50mb' })) // 50mb for base64 image payloads in AI proxy

// PostgreSQL pool
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'ZetronixDocs',
  user: process.env.DB_USER || 'Zetronix',
  password: process.env.DB_PASSWORD || 'zenza_password',
})

// Стоимость токенов (рублей за 1000 токенов)
const COST_PER_1K = {
  standard: parseFloat(process.env.COST_PER_1K_TOKENS_STANDARD || '0.50'),
  extended: parseFloat(process.env.COST_PER_1K_TOKENS_EXTENDED || '2.00'),
  structure: parseFloat(process.env.COST_PER_1K_TOKENS_STRUCTURE || '0.30'),
}

// ─── JWT Auth middleware ──────────────────────────────────────────
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Требуется авторизация' })
  }
  const token = auth.slice(7)
  try {
    req.admin = jwt.verify(token, JWT_SECRET)
    next()
  } catch {
    return res.status(401).json({ error: 'Недействительный токен' })
  }
}

// ─── Health check ─────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() })
})

// ═══════════════════════════════════════════════════════════════════
// AI PROXY ENDPOINTS — клиентские запросы проксируются через сервер
// ═══════════════════════════════════════════════════════════════════

// ─── Client: register machine + get config ───
app.post('/api/client/register', async (req, res) => {
  const { machineId, hostname, localIp, keyId, customer } = req.body
  if (!machineId) {
    return res.status(400).json({ error: 'Не указан machineId' })
  }
  try {
    await aiProxy.registerClientMachine(pool, { machineId, hostname, localIp, keyId, customer })
    res.json({ success: true })
  } catch (err) {
    console.error('Client register error:', err)
    res.status(500).json({ error: 'Ошибка регистрации' })
  }
})

// ─── Client: get config (polled every 30s) ───
app.get('/api/client/config', async (req, res) => {
  const { machineId } = req.query
  try {
    const config = await aiProxy.getAllConfig(pool)

    // Update last_seen
    if (machineId) {
      await pool.query(
        'UPDATE client_machines SET last_seen = CURRENT_TIMESTAMP WHERE machine_id = $1',
        [machineId]
      )
    }

    // Get client-specific rate limit
    let rateLimitRpm = parseInt(config.global_rate_limit_rpm) || 12
    if (machineId) {
      const clientLimit = await aiProxy.getClientRateLimit(pool, machineId)
      rateLimitRpm = clientLimit
    }

    // Get active providers
    const providersResult = await pool.query(
      'SELECT provider FROM ai_providers WHERE is_active = TRUE'
    )
    const activeProviders = providersResult.rows.map(r => r.provider)

    res.json({
      ocr_provider: config.ocr_provider || 'tsar',
      ocr_endpoint: config.ocr_endpoint || 'https://api.tsarrouter.ru/v1',
      ocr_model: config.ocr_model || 'yandex/ocr-markdown',
      repair_ocr_model: config.repair_ocr_model || 'deepseek-ai/DeepSeek-OCR-2',
      gigachat_endpoint: config.gigachat_endpoint || 'https://api.giga.chat/v1',
      gigachat_oauth_url: config.gigachat_oauth_url || 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
      gigachat_model: config.gigachat_model || 'GigaChat-2',
      mistral_provider: config.mistral_provider || 'direct',
      mistral_endpoint: config.mistral_endpoint || 'https://api.mistral.ai/v1',
      routerai_endpoint: config.routerai_endpoint || 'https://routerai.ru/api/v1',
      rate_limit_rpm: rateLimitRpm,
      app_version: config.app_version || '1.0.0',
      min_required_version: config.min_required_version || '1.0.0',
      force_update: config.force_update === 'true',
      update_url: config.update_url || '',
      proxy_enabled: config.proxy_enabled !== 'false',
      active_providers: activeProviders,
    })
  } catch (err) {
    console.error('Client config error:', err)
    res.status(500).json({ error: 'Ошибка получения конфига' })
  }
})

// ─── Proxy: Tsar Router OCR ───
app.post('/api/proxy/tsar/ocr', async (req, res) => {
  await aiProxy.proxyTsarOcr(pool, req, res)
})

// ─── Proxy: GigaChat OAuth ───
app.post('/api/proxy/gigachat/oauth', async (req, res) => {
  await aiProxy.proxyGigachatOAuth(pool, req, res)
})

// ─── Proxy: GigaChat chat/completions ───
app.post('/api/proxy/gigachat/chat', async (req, res) => {
  await aiProxy.proxyGigachatChat(pool, req, res)
})

// ─── Proxy: Mistral OCR ───
app.post('/api/proxy/mistral/ocr', async (req, res) => {
  await aiProxy.proxyMistralOcr(pool, req, res)
})

// ─── Proxy: Mistral file upload ───
app.post('/api/proxy/mistral/upload', async (req, res) => {
  await aiProxy.proxyMistralUpload(pool, req, res)
})

// ─── Proxy: Mistral file delete ───
app.post('/api/proxy/mistral/delete', async (req, res) => {
  await aiProxy.proxyMistralDelete(pool, req, res)
})

// ─── Proxy: RouterAI ───
app.post('/api/proxy/routerai', async (req, res) => {
  await aiProxy.proxyRouterAi(pool, req, res)
})

// ═══════════════════════════════════════════════════════════════
// 1C MAPPING ENDPOINTS (client-facing)
// ═══════════════════════════════════════════════════════════════

// ─── Get 1C mapping for client ───
// Client sends keyId + config_type (detected from 1C), receives mapping JSON
app.post('/api/client/onec-mapping', async (req, res) => {
  const { keyId, configType, configName } = req.body

  if (!keyId) {
    return res.status(400).json({ error: 'Не указан keyId' })
  }

  try {
    // 1. Check if client has a custom mapping in DB
    const result = await pool.query(
      'SELECT mapping_json, schema_json FROM onec_mappings WHERE key_id = $1 AND is_active = TRUE ORDER BY updated_at DESC LIMIT 1',
      [keyId]
    )

    if (result.rows.length > 0) {
      const row = result.rows[0]
      return res.json({
        source: 'custom',
        mapping: JSON.parse(row.mapping_json),
        schema: row.schema_json ? JSON.parse(row.schema_json) : null,
      })
    }

    // 2. No custom mapping — try preset by config_type
    const preset = onecPresets.getPreset(configType || 'custom')
    if (preset) {
      return res.json({
        source: 'preset',
        config_type: preset.config_type,
        config_name: preset.config_name,
        mapping: preset,
      })
    }

    // 3. No preset — return default universal mapping
    return res.json({
      source: 'default',
      mapping: {
        config_type: 'custom',
        config_name: configName || 'Неизвестная конфигурация',
        document_type_mapping: {},
        metadata_mapping: {},
        table_mapping: {
          tabular_section: 'Товары',
          column_mapping: {},
        },
      },
    })
  } catch (err) {
    console.error('1C mapping error:', err)
    res.status(500).json({ error: 'Ошибка получения маппинга 1С' })
  }
})

// ─── Save 1C schema from client (when client fetches /schema from their 1C) ───
app.post('/api/client/onec-schema', async (req, res) => {
  const { keyId, customer, configType, configName, schema } = req.body

  if (!keyId || !schema) {
    return res.status(400).json({ error: 'Не указан keyId или schema' })
  }

  try {
    // Store schema in DB (upsert by key_id)
    await pool.query(`
      INSERT INTO onec_mappings (key_id, customer, config_type, config_name, schema_json, is_active, updated_at)
      VALUES ($1, $2, $3, $4, $5, TRUE, CURRENT_TIMESTAMP)
      ON CONFLICT (key_id) DO UPDATE SET
        schema_json = EXCLUDED.schema_json,
        config_type = EXCLUDED.config_type,
        config_name = EXCLUDED.config_name,
        updated_at = CURRENT_TIMESTAMP
    `, [keyId, customer || '', configType || 'custom', configName || '', JSON.stringify(schema)])

    res.json({ success: true, message: 'Схема 1С сохранена' })
  } catch (err) {
    console.error('1C schema save error:', err)
    res.status(500).json({ error: 'Ошибка сохранения схемы' })
  }
})

// ─── License activation ───────────────────────────────────────────
app.post('/api/license/activate', async (req, res) => {
  const { keyId, machineId, customer } = req.body

  if (!keyId || !machineId) {
    return res.status(400).json({ error: 'Не указан keyId или machineId' })
  }

  try {
    const licResult = await pool.query(
      'SELECT id, revoked, expiry_date, unlimited, max_activations FROM licenses WHERE key_id = $1',
      [keyId]
    )

    if (licResult.rows.length === 0) {
      return res.status(404).json({ error: 'Лицензия не найдена', revoked: false })
    }

    const license = licResult.rows[0]

    if (license.revoked) {
      return res.json({ success: false, revoked: true, message: 'Лицензия отозвана' })
    }

    // Проверяем срок действия
    if (!license.unlimited && license.expiry_date) {
      if (new Date(license.expiry_date) < new Date()) {
        return res.json({ success: false, expired: true, message: 'Срок действия лицензии истёк' })
      }
    }

    // Проверяем, уже ли активировано это устройство
    const existingAct = await pool.query(
      'SELECT id FROM activations WHERE key_id = $1 AND machine_id = $2',
      [keyId, machineId]
    )

    if (existingAct.rows.length === 0) {
      // Новая активация — проверяем лимит
      const countResult = await pool.query(
        'SELECT COUNT(DISTINCT machine_id) as cnt FROM activations WHERE key_id = $1',
        [keyId]
      )
      const currentCount = parseInt(countResult.rows[0].cnt)
      const maxAct = license.max_activations || 1

      if (currentCount >= maxAct) {
        return res.json({
          success: false,
          limit_reached: true,
          message: `Достигнут лимит активаций (${maxAct}). Обратитесь к администратору для увеличения числа пользователей.`,
          maxActivations: maxAct,
          currentActivations: currentCount,
        })
      }
    }

    // Регистрируем активацию (или обновляем last_seen)
    await pool.query(`
      INSERT INTO activations (license_id, key_id, machine_id, customer, activated_at, last_seen)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (key_id, machine_id)
      DO UPDATE SET last_seen = CURRENT_TIMESTAMP
    `, [license.id, keyId, machineId, customer || 'Unknown'])

    res.json({ success: true, message: 'Активация зарегистрирована' })
  } catch (err) {
    console.error('Activation error:', err)
    res.status(500).json({ error: 'Внутренняя ошибка сервера' })
  }
})

// ─── License status check (для периодической проверки) ────────────
app.post('/api/license/check', async (req, res) => {
  const { keyId, machineId } = req.body

  if (!keyId) {
    return res.status(400).json({ error: 'Не указан keyId' })
  }

  try {
    const licResult = await pool.query(
      'SELECT revoked, expiry_date, unlimited, max_activations FROM licenses WHERE key_id = $1',
      [keyId]
    )

    if (licResult.rows.length === 0) {
      return res.json({ valid: false, reason: 'not_found' })
    }

    const license = licResult.rows[0]

    if (license.revoked) {
      return res.json({ valid: false, reason: 'revoked', message: 'Лицензия отозвана' })
    }

    if (!license.unlimited && license.expiry_date) {
      if (new Date(license.expiry_date) < new Date()) {
        return res.json({ valid: false, reason: 'expired', message: 'Срок действия истёк' })
      }
    }

    // Обновляем last_seen если передан machineId
    if (machineId) {
      await pool.query(
        'UPDATE activations SET last_seen = CURRENT_TIMESTAMP WHERE key_id = $1 AND machine_id = $2',
        [keyId, machineId]
      )
    }

    res.json({
      valid: true,
      unlimited: license.unlimited,
      expiry_date: license.expiry_date,
      max_activations: license.max_activations,
    })
  } catch (err) {
    console.error('License check error:', err)
    res.status(500).json({ error: 'Внутренняя ошибка сервера' })
  }
})

// ─── Token usage report ───────────────────────────────────────────
app.post('/api/usage/report', async (req, res) => {
  const { keyId, customer, machineId, tokensUsed, costRubles, documentType } = req.body

  if (!keyId || !tokensUsed) {
    return res.status(400).json({ error: 'Не указан keyId или tokensUsed' })
  }

  try {
    // Находим лицензию
    const licResult = await pool.query('SELECT id FROM licenses WHERE key_id = $1', [keyId])
    const licenseId = licResult.rows.length > 0 ? licResult.rows[0].id : null

    // Рассчитываем стоимость, если не передана
    let cost = costRubles
    if (cost === undefined || cost === null) {
      const type = documentType || 'standard'
      const costPer1k = COST_PER_1K[type] || COST_PER_1K.standard
      cost = Math.round((tokensUsed / 1000) * costPer1k * 100) / 100
    }

    await pool.query(`
      INSERT INTO token_usage (license_id, key_id, customer, machine_id, tokens_used, cost_rubles, document_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [licenseId, keyId, customer || 'Unknown', machineId, tokensUsed, cost, documentType || 'standard'])

    res.json({ success: true })
  } catch (err) {
    console.error('Usage report error:', err)
    res.status(500).json({ error: 'Внутренняя ошибка сервера' })
  }
})

// ─── Admin login ──────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  const { login, password } = req.body

  // Для простоты используем те же учётные данные, что и в приложении
  // В продакшене можно вынести в БД
  if (login !== 'Zetronix') {
    return res.status(401).json({ error: 'Неверный логин или пароль' })
  }

  // Хэш пароля ZetronixIT$20 (предварительно вычисленный bcrypt)
  const ADMIN_PASSWORD_HASH = '$2a$10$' // placeholder — замените на реальный bcrypt-хэш

  // Простая проверка для начала (замените на bcrypt.compare)
  if (password !== 'ZetronixIT$20') {
    return res.status(401).json({ error: 'Неверный логин или пароль' })
  }

  const token = jwt.sign({ login: 'Zetronix', role: 'admin' }, JWT_SECRET, { expiresIn: '24h' })
  res.json({ token })
})

// ─── Weekly report ────────────────────────────────────────────────
app.get('/api/admin/report', authMiddleware, async (req, res) => {
  try {
    // Отчёт по использованию за последние 7 дней
    const usageResult = await pool.query(`
      SELECT
        customer,
        key_id,
        document_type,
        SUM(tokens_used) as total_tokens,
        SUM(cost_rubles) as total_cost_rubles,
        COUNT(*) as request_count
      FROM token_usage
      WHERE recorded_at >= NOW() - INTERVAL '7 days'
      GROUP BY customer, key_id, document_type
      ORDER BY total_cost_rubles DESC
    `)

    // Сводка по каждому клиенту
    const customerSummary = await pool.query(`
      SELECT
        l.customer,
        l.plan,
        l.unlimited,
        l.expiry_date,
        l.key_id,
        l.revoked,
        l.token_limit,
        COALESCE(usage.week_tokens, 0) as week_tokens,
        COALESCE(usage.week_cost, 0) as week_cost,
        COALESCE(usage.month_tokens, 0) as month_tokens,
        COALESCE(usage.month_cost, 0) as month_cost,
        CASE
          WHEN l.unlimited THEN NULL
          WHEN l.expiry_date IS NULL THEN NULL
          ELSE EXTRACT(DAY FROM l.expiry_date - NOW())
        END as days_remaining
      FROM licenses l
      LEFT JOIN (
        SELECT
          key_id,
          SUM(tokens_used) FILTER (WHERE recorded_at >= NOW() - INTERVAL '7 days') as week_tokens,
          SUM(cost_rubles) FILTER (WHERE recorded_at >= NOW() - INTERVAL '7 days') as week_cost,
          SUM(tokens_used) FILTER (WHERE recorded_at >= NOW() - INTERVAL '30 days') as month_tokens,
          SUM(cost_rubles) FILTER (WHERE recorded_at >= NOW() - INTERVAL '30 days') as month_cost
        FROM token_usage
        GROUP BY key_id
      ) usage ON usage.key_id = l.key_id
      WHERE l.revoked = FALSE
      ORDER BY l.customer
    `)

    // Общие итоги
    const totals = await pool.query(`
      SELECT
        SUM(tokens_used) FILTER (WHERE recorded_at >= NOW() - INTERVAL '7 days') as week_total_tokens,
        SUM(cost_rubles) FILTER (WHERE recorded_at >= NOW() - INTERVAL '7 days') as week_total_cost,
        SUM(tokens_used) FILTER (WHERE recorded_at >= NOW() - INTERVAL '30 days') as month_total_tokens,
        SUM(cost_rubles) FILTER (WHERE recorded_at >= NOW() - INTERVAL '30 days') as month_total_cost,
        COUNT(DISTINCT customer) FILTER (WHERE recorded_at >= NOW() - INTERVAL '7 days') as active_customers_week
      FROM token_usage
    `)

    res.json({
      generatedAt: new Date().toISOString(),
      period: '7 дней',
      totals: totals.rows[0],
      customers: customerSummary.rows,
      usageDetails: usageResult.rows,
    })
  } catch (err) {
    console.error('Report error:', err)
    res.status(500).json({ error: 'Ошибка формирования отчёта' })
  }
})

// ─── All licenses ─────────────────────────────────────────────────
app.get('/api/admin/licenses', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        l.*,
        COUNT(DISTINCT a.machine_id) as activations_count,
        MAX(a.last_seen) as last_activity
      FROM licenses l
      LEFT JOIN activations a ON a.license_id = l.id
      GROUP BY l.id
      ORDER BY l.created_at DESC
    `)
    res.json({ licenses: result.rows })
  } catch (err) {
    console.error('Licenses error:', err)
    res.status(500).json({ error: 'Ошибка получения списка лицензий' })
  }
})

// ─── Revoke license ───────────────────────────────────────────────
app.post('/api/admin/revoke', authMiddleware, async (req, res) => {
  const { keyId } = req.body
  if (!keyId) return res.status(400).json({ error: 'Не указан keyId' })

  try {
    await pool.query(
      'UPDATE licenses SET revoked = TRUE, revoked_at = CURRENT_TIMESTAMP WHERE key_id = $1',
      [keyId]
    )
    res.json({ success: true, message: 'Лицензия отозвана' })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка отзыва лицензии' })
  }
})

// ─── Change max activations (изменение числа пользователей) ───────
app.post('/api/admin/set-activations', authMiddleware, async (req, res) => {
  const { keyId, maxActivations } = req.body
  if (!keyId || maxActivations === undefined) {
    return res.status(400).json({ error: 'Укажите keyId и maxActivations' })
  }

  const newMax = parseInt(maxActivations)
  if (newMax < 1) {
    return res.status(400).json({ error: 'Минимум 1 пользователь' })
  }

  try {
    // Проверяем текущее количество активаций
    const countResult = await pool.query(
      'SELECT COUNT(DISTINCT machine_id) as cnt FROM activations WHERE key_id = $1',
      [keyId]
    )
    const currentCount = parseInt(countResult.rows[0].cnt)

    if (newMax < currentCount) {
      return res.json({
        success: false,
        message: `Нельзя уменьшить до ${newMax}: уже активировано ${currentCount} устройств. Сначала отключите лишние.`,
        currentActivations: currentCount,
      })
    }

    await pool.query(
      'UPDATE licenses SET max_activations = $1 WHERE key_id = $2',
      [newMax, keyId]
    )

    res.json({
      success: true,
      message: `Лимит пользователей изменён на ${newMax}`,
      maxActivations: newMax,
    })
  } catch (err) {
    console.error('Set activations error:', err)
    res.status(500).json({ error: 'Ошибка: ' + err.message })
  }
})

// ─── List activations for a license ───────────────────────────────
app.get('/api/admin/activations/:keyId', authMiddleware, async (req, res) => {
  const { keyId } = req.params
  try {
    const result = await pool.query(
      'SELECT machine_id, customer, activated_at, last_seen FROM activations WHERE key_id = $1 ORDER BY last_seen DESC',
      [keyId]
    )
    res.json({ activations: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка получения активаций' })
  }
})

// ─── Deactivate a specific device ─────────────────────────────────
app.post('/api/admin/deactivate', authMiddleware, async (req, res) => {
  const { keyId, machineId } = req.body
  if (!keyId || !machineId) {
    return res.status(400).json({ error: 'Укажите keyId и machineId' })
  }
  try {
    await pool.query(
      'DELETE FROM activations WHERE key_id = $1 AND machine_id = $2',
      [keyId, machineId]
    )
    res.json({ success: true, message: 'Устройство отключено' })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка отключения устройства' })
  }
})

// ─── Delete license (полное удаление клиента из БД) ───────────────
app.post('/api/admin/delete', authMiddleware, async (req, res) => {
  const { keyId } = req.body
  if (!keyId) return res.status(400).json({ error: 'Не указан keyId' })

  try {
    // Удаляем лицензию — каскадно удалятся активации и token_usage (ON DELETE CASCADE)
    const result = await pool.query(
      'DELETE FROM licenses WHERE key_id = $1 RETURNING customer',
      [keyId]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Лицензия не найдена' })
    }
    res.json({ success: true, message: `Клиент "${result.rows[0].customer}" удалён` })
  } catch (err) {
    console.error('Delete license error:', err)
    res.status(500).json({ error: 'Ошибка удаления: ' + err.message })
  }
})

// ─── Extend license (продление) ───────────────────────────────────
app.post('/api/admin/extend', authMiddleware, async (req, res) => {
  const { keyId, addDays, addPriceRubles, addAiBudgetRubles } = req.body
  if (!keyId || !addDays) {
    return res.status(400).json({ error: 'Укажите keyId и количество дней' })
  }

  try {
    // Получаем текущую лицензию
    const licResult = await pool.query(
      'SELECT id, customer, expiry_date, unlimited, price_rubles, ai_budget_rubles, license_key FROM licenses WHERE key_id = $1',
      [keyId]
    )
    if (licResult.rows.length === 0) {
      return res.status(404).json({ error: 'Лицензия не найдена' })
    }
    const lic = licResult.rows[0]

    if (lic.unlimited) {
      return res.json({ success: false, message: 'Безлимитная лицензия не требует продления' })
    }

    // Вычисляем новую дату истечения:
    // если ещё не истекла — прибавляем к текущей дате
    // если истекла — прибавляем от сегодня
    const now = new Date()
    const currentExpiry = lic.expiry_date ? new Date(lic.expiry_date) : now
    const baseDate = currentExpiry > now ? currentExpiry : now
    const newExpiry = new Date(baseDate)
    newExpiry.setDate(newExpiry.getDate() + parseInt(addDays))

    // Обновляем БД
    const newPrice = parseFloat(lic.price_rubles || 0) + parseFloat(addPriceRubles || 0)
    const newBudget = parseFloat(lic.ai_budget_rubles || 0) + parseFloat(addAiBudgetRubles || 0)

    await pool.query(
      'UPDATE licenses SET expiry_date = $1, price_rubles = $2, ai_budget_rubles = $3, revoked = FALSE WHERE key_id = $4',
      [newExpiry, newPrice, newBudget, keyId]
    )

    res.json({
      success: true,
      message: `Лицензия продлена на ${addDays} дней. Новая дата: ${newExpiry.toLocaleDateString('ru-RU')}`,
      newExpiry: newExpiry.toISOString(),
      newPrice,
      newBudget,
    })
  } catch (err) {
    console.error('Extend error:', err)
    res.status(500).json({ error: 'Ошибка продления: ' + err.message })
  }
})

// ─── Generate license via admin panel ─────────────────────────────
app.post('/api/admin/generate-license', authMiddleware, async (req, res) => {
  const {
    customer,
    customerType,    // individual | small | large
    plan,            // trial | small | large | staff
    days,            // null = unlimited
    unlimited,       // true for staff
    priceRubles,     // сколько клиент заплатил
    aiBudgetRubles,  // бюджет на ИИ
    adminNote,
    maxActivations,  // лимит устройств (пользователей)
  } = req.body

  if (!customer) {
    return res.status(400).json({ error: 'Укажите наименование клиента' })
  }

  try {
    // Читаем приватный ключ
    const privateKeyPath = path.join(__dirname, '..', 'keys', 'private_key.pem')
    if (!fs.existsSync(privateKeyPath)) {
      return res.status(500).json({ error: 'Приватный ключ не найден на сервере' })
    }
    const privateKey = fs.readFileSync(privateKeyPath, 'utf8')

    // Формируем payload
    const issuedAt = new Date().toISOString()
    const keyId = crypto.randomBytes(8).toString('hex')
    let expiry = null

    if (!unlimited && days) {
      const expiryDate = new Date()
      expiryDate.setDate(expiryDate.getDate() + parseInt(days))
      expiry = expiryDate.toISOString()
    }

    // Токен-лимит по тарифу
    const tokenLimits = { trial: 50000, small: 200000, large: 1000000, staff: 0 }
    const tokenLimit = tokenLimits[plan] || 0

    const payload = {
      customer,
      plan: plan || 'small',
      expiry,
      unlimited: !!unlimited,
      tokenLimit,
      issuedAt,
      keyId,
    }

    // Подписываем
    const payloadJson = JSON.stringify(payload)
    const sign = crypto.createSign('RSA-SHA256')
    sign.update(payloadJson)
    sign.end()
    const signature = sign.sign(privateKey)

    const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64')
    const signatureB64 = signature.toString('base64')
    const licenseKey = `Zetronix1.${payloadB64}.${signatureB64}`

    // Сохраняем в БД
    await pool.query(`
      INSERT INTO licenses
        (key_id, customer, plan, expiry_date, unlimited, token_limit, issued_at,
         license_key, customer_type, price_rubles, ai_budget_rubles, admin_note, max_activations)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `, [
      keyId,
      customer,
      plan || 'small',
      expiry ? new Date(expiry) : null,
      !!unlimited,
      tokenLimit,
      new Date(issuedAt),
      licenseKey,
      customerType || 'small',
      parseFloat(priceRubles) || 0,
      parseFloat(aiBudgetRubles) || 0,
      adminNote || '',
      parseInt(maxActivations) || 1,
    ])

    res.json({
      success: true,
      licenseKey,
      keyId,
      customer,
      plan: plan || 'small',
      expiry,
      unlimited: !!unlimited,
      tokenLimit,
    })
  } catch (err) {
    console.error('Generate license error:', err)
    res.status(500).json({ error: 'Ошибка генерации лицензии: ' + err.message })
  }
})

// ─── License details (for admin panel — includes full key) ────────
app.get('/api/admin/licenses/full', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        l.id, l.key_id, l.customer, l.plan, l.customer_type,
        l.expiry_date, l.unlimited, l.token_limit,
        l.price_rubles, l.ai_budget_rubles, l.admin_note,
        l.license_key, l.revoked, l.revoked_at,
        l.issued_at, l.created_at, l.max_activations,
        COALESCE(act.activations_count, 0) as activations_count,
        act.last_activity,
        COALESCE(usage.total_tokens, 0) as total_tokens_used,
        COALESCE(usage.total_cost, 0) as total_ai_cost
      FROM licenses l
      LEFT JOIN (
        SELECT license_id,
          COUNT(DISTINCT machine_id) as activations_count,
          MAX(last_seen) as last_activity
        FROM activations
        GROUP BY license_id
      ) act ON act.license_id = l.id
      LEFT JOIN (
        SELECT key_id,
          SUM(tokens_used) as total_tokens,
          SUM(cost_rubles) as total_cost
        FROM token_usage
        GROUP BY key_id
      ) usage ON usage.key_id = l.key_id
      ORDER BY l.created_at DESC
    `)
    res.json({ licenses: result.rows })
  } catch (err) {
    console.error('Licenses full error:', err)
    res.status(500).json({ error: 'Ошибка получения списка лицензий' })
  }
})

// ═══════════════════════════════════════════════════════════════════
// ADMIN: AI PROVIDERS MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

// ─── List all AI providers ───
app.get('/api/admin/ai-providers', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ai_providers ORDER BY provider, label')
    res.json({ providers: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка получения списка провайдеров' })
  }
})

// ─── Add/update AI provider key ───
app.post('/api/admin/ai-providers', authMiddleware, async (req, res) => {
  const { provider, label, apiKey, endpoint, isActive } = req.body
  if (!provider || !apiKey || !endpoint) {
    return res.status(400).json({ error: 'Укажите provider, apiKey, endpoint' })
  }
  try {
    await pool.query(`
      INSERT INTO ai_providers (provider, label, api_key, endpoint, is_active, updated_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      ON CONFLICT (provider, label) DO UPDATE SET
        api_key = EXCLUDED.api_key,
        endpoint = EXCLUDED.endpoint,
        is_active = EXCLUDED.is_active,
        updated_at = CURRENT_TIMESTAMP
    `, [provider, label || provider, apiKey, endpoint, isActive !== false])
    res.json({ success: true, message: 'Провайдер сохранён' })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сохранения: ' + err.message })
  }
})

// ─── Delete AI provider ───
app.post('/api/admin/ai-providers/delete', authMiddleware, async (req, res) => {
  const { id } = req.body
  if (!id) return res.status(400).json({ error: 'Укажите id' })
  try {
    await pool.query('DELETE FROM ai_providers WHERE id = $1', [id])
    res.json({ success: true, message: 'Провайдер удалён' })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления' })
  }
})

// ═══════════════════════════════════════════════════════════════════
// ADMIN: CLIENT MACHINES MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

// ─── List all client machines ───
app.get('/api/admin/machines', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*,
        l.customer as license_customer,
        l.plan as license_plan
      FROM client_machines m
      LEFT JOIN licenses l ON l.key_id = m.key_id
      ORDER BY m.last_seen DESC
    `)
    res.json({ machines: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка получения списка устройств' })
  }
})

// ─── Update machine rate limit ───
app.post('/api/admin/machines/rate-limit', authMiddleware, async (req, res) => {
  const { machineId, rateLimitRpm } = req.body
  if (!machineId) return res.status(400).json({ error: 'Укажите machineId' })
  try {
    await pool.query(
      'UPDATE client_machines SET rate_limit_rpm = $1 WHERE machine_id = $2',
      [parseInt(rateLimitRpm), machineId]
    )
    res.json({ success: true, message: `Rate limit изменён на ${rateLimitRpm} RPM` })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка обновления' })
  }
})

// ─── Delete machine ───
app.post('/api/admin/machines/delete', authMiddleware, async (req, res) => {
  const { machineId } = req.body
  if (!machineId) return res.status(400).json({ error: 'Укажите machineId' })
  try {
    await pool.query('DELETE FROM client_machines WHERE machine_id = $1', [machineId])
    res.json({ success: true, message: 'Устройство удалено' })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления' })
  }
})

// ═══════════════════════════════════════════════════════════════════
// ADMIN: APP CONFIG MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

// ─── Get all config ───
app.get('/api/admin/config', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value, updated_at FROM app_config ORDER BY key')
    const config = {}
    for (const row of result.rows) {
      config[row.key] = row.value
    }
    res.json({ config })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка получения конфига' })
  }
})

// ─── Update config key ───
app.post('/api/admin/config', authMiddleware, async (req, res) => {
  const { key, value } = req.body
  if (!key) return res.status(400).json({ error: 'Укажите key' })
  try {
    await pool.query(`
      INSERT INTO app_config (key, value, updated_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
    `, [key, String(value)])
    res.json({ success: true, message: `Конфиг обновлён: ${key}` })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка обновления конфига' })
  }
})

// ═══════════════════════════════════════════════════════════════════
// ADMIN: 1C MAPPINGS MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

// ─── List all 1C mappings ───
app.get('/api/admin/onec-mappings', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*,
        l.customer as license_customer
      FROM onec_mappings m
      LEFT JOIN licenses l ON l.key_id = m.key_id
      ORDER BY m.updated_at DESC
    `)
    res.json({ mappings: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка получения списка маппингов' })
  }
})

// ─── Get single 1C mapping ───
app.get('/api/admin/onec-mappings/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM onec_mappings WHERE id = $1', [req.params.id])
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Маппинг не найден' })
    }
    res.json({ mapping: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка получения маппинга' })
  }
})

// ─── Save/update 1C mapping ───
app.post('/api/admin/onec-mappings', authMiddleware, async (req, res) => {
  const { id, keyId, customer, configType, configName, mappingJson } = req.body
  if (!keyId || !mappingJson) {
    return res.status(400).json({ error: 'Укажите keyId и mappingJson' })
  }
  try {
    const mappingStr = typeof mappingJson === 'string' ? mappingJson : JSON.stringify(mappingJson)
    await pool.query(`
      INSERT INTO onec_mappings (key_id, customer, config_type, config_name, mapping_json, is_active, updated_at)
      VALUES ($1, $2, $3, $4, $5, TRUE, CURRENT_TIMESTAMP)
      ON CONFLICT (key_id) DO UPDATE SET
        mapping_json = EXCLUDED.mapping_json,
        config_type = EXCLUDED.config_type,
        config_name = EXCLUDED.config_name,
        customer = EXCLUDED.customer,
        updated_at = CURRENT_TIMESTAMP
    `, [keyId, customer || '', configType || 'custom', configName || '', mappingStr])
    res.json({ success: true, message: 'Маппинг сохранён' })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сохранения: ' + err.message })
  }
})

// ─── Delete 1C mapping ───
app.post('/api/admin/onec-mappings/delete', authMiddleware, async (req, res) => {
  const { id } = req.body
  if (!id) return res.status(400).json({ error: 'Укажите id' })
  try {
    await pool.query('DELETE FROM onec_mappings WHERE id = $1', [id])
    res.json({ success: true, message: 'Маппинг удалён' })
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления' })
  }
})

// ─── List available presets ───
app.get('/api/admin/onec-presets', authMiddleware, async (req, res) => {
  res.json({ presets: onecPresets.getAllPresets() })
})

// ─── Serve admin panel HTML ───────────────────────────────────────
app.get('/admin', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(getAdminHtml())
})

app.get('/admin/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(getAdminHtml())
})

function getAdminHtml() {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ZetronixDocs — Админ-панель</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e4e4e7; min-height: 100vh; }
  .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
  .header { display: flex; align-items: center; justify-content: space-between; padding: 20px 0; border-bottom: 1px solid #27272a; margin-bottom: 24px; }
  .logo { display: flex; align-items: center; gap: 12px; }
  .logo-text { font-size: 20px; font-weight: 700; color: #6366f1; }
  .logo-sub { font-size: 12px; color: #71717a; }
  .btn { padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s; }
  .btn-primary { background: #6366f1; color: white; }
  .btn-primary:hover { background: #4f46e5; }
  .btn-secondary { background: #27272a; color: #e4e4e7; }
  .btn-secondary:hover { background: #3f3f46; }
  .btn-danger { background: #dc2626; color: white; }
  .btn-danger:hover { background: #b91c1c; }
  .btn-sm { padding: 6px 12px; font-size: 12px; }
  .card { background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 24px; margin-bottom: 20px; }
  .card-title { font-size: 18px; font-weight: 600; margin-bottom: 16px; color: #e4e4e7; }
  .toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
  .search-box { flex: 1; min-width: 200px; max-width: 400px; padding: 10px 14px; background: #0f1117; border: 1px solid #3f3f46; border-radius: 8px; color: #e4e4e7; font-size: 14px; outline: none; }
  .search-box:focus { border-color: #6366f1; }
  .sort-select { padding: 10px 14px; background: #0f1117; border: 1px solid #3f3f46; border-radius: 8px; color: #e4e4e7; font-size: 14px; outline: none; cursor: pointer; }
  .sort-select:focus { border-color: #6366f1; }
  th { cursor: pointer; user-select: none; }
  th:hover { color: #a1a1aa; }
  th .sort-arrow { font-size: 10px; margin-left: 4px; opacity: 0.5; }
  th.sorted .sort-arrow { opacity: 1; color: #6366f1; }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .form-group { display: flex; flex-direction: column; gap: 6px; }
  .form-group.full { grid-column: 1 / -1; }
  label { font-size: 13px; color: #a1a1aa; font-weight: 500; }
  input, select, textarea { padding: 10px 12px; background: #0f1117; border: 1px solid #3f3f46; border-radius: 8px; color: #e4e4e7; font-size: 14px; outline: none; }
  input:focus, select:focus, textarea:focus { border-color: #6366f1; }
  textarea { resize: vertical; min-height: 60px; font-family: inherit; }
  .login-screen { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .login-box { width: 100%; max-width: 400px; }
  .login-box .card { padding: 32px; }
  .error { color: #ef4444; font-size: 14px; margin-top: 8px; }
  .success { color: #22c55e; font-size: 14px; margin-top: 8px; }
  .tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid #27272a; }
  .tab { padding: 12px 20px; cursor: pointer; color: #71717a; font-size: 14px; font-weight: 500; border-bottom: 2px solid transparent; transition: all 0.2s; }
  .tab.active { color: #6366f1; border-bottom-color: #6366f1; }
  .tab:hover { color: #e4e4e7; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #27272a; font-size: 13px; }
  th { color: #71717a; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  tr:hover { background: #1f1f23; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .badge-green { background: #166534; color: #4ade80; }
  .badge-red { background: #7f1d1d; color: #f87171; }
  .badge-yellow { background: #713f12; color: #facc15; }
  .badge-blue { background: #1e3a8a; color: #60a5fa; }
  .badge-gray { background: #3f3f46; color: #a1a1aa; }
  .key-box { background: #0f1117; border: 1px solid #3f3f46; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 12px; word-break: break-all; margin: 12px 0; cursor: pointer; }
  .key-box:hover { border-color: #6366f1; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 20px; }
  .stat-card { background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 20px; }
  .stat-label { font-size: 12px; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-value { font-size: 28px; font-weight: 700; color: #e4e4e7; margin-top: 4px; }
  .stat-sub { font-size: 12px; color: #a1a1aa; margin-top: 4px; }
  .progress { height: 8px; background: #27272a; border-radius: 4px; overflow: hidden; margin-top: 8px; }
  .progress-bar { height: 100%; background: #6366f1; transition: width 0.3s; }
  .progress-bar.warn { background: #facc15; }
  .progress-bar.danger { background: #ef4444; }
  .copy-btn { background: none; border: none; color: #6366f1; cursor: pointer; font-size: 12px; padding: 2px 6px; }
  .copy-btn:hover { text-decoration: underline; }
  .hidden { display: none; }
  .row-actions { display: flex; gap: 8px; }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .form-group { display: flex; flex-direction: column; gap: 4px; }
  .form-group.full { grid-column: 1 / -1; }
  .form-group label { font-size: 12px; color: #71717a; font-weight: 500; }
  .form-group input, .form-group select { background: #0f1117; border: 1px solid #3f3f46; border-radius: 8px; padding: 10px 12px; color: #e4e4e7; font-size: 14px; }
  .form-group input:focus, .form-group select:focus { outline: none; border-color: #6366f1; }
  .form-group small { font-size: 11px; color: #71717a; margin-top: 2px; }
  .error { color: #ef4444; font-size: 14px; margin-top: 8px; }
  @media (max-width: 768px) {
    .form-grid { grid-template-columns: 1fr; }
    .stats { grid-template-columns: 1fr 1fr; }
  }
</style>
</head>
<body>

<!-- Login Screen -->
<div id="loginScreen" class="login-screen">
  <div class="login-box">
    <div class="card">
      <div class="logo" style="margin-bottom: 24px;">
        <div>
          <div class="logo-text">ZetronixDocs</div>
          <div class="logo-sub">Админ-панель</div>
        </div>
      </div>
      <div class="form-group" style="margin-bottom: 16px;">
        <label>Логин</label>
        <input type="text" id="loginInput" placeholder="Введите логин" autofocus>
      </div>
      <div class="form-group" style="margin-bottom: 16px;">
        <label>Пароль</label>
        <input type="password" id="passwordInput" placeholder="Введите пароль">
      </div>
      <div id="loginError" class="error hidden"></div>
      <button class="btn btn-primary" style="width: 100%;" onclick="doLogin()">Войти</button>
    </div>
  </div>
</div>

<!-- Main App -->
<div id="mainApp" class="container hidden">
  <div class="header">
    <div class="logo">
      <div>
        <div class="logo-text">ZetronixDocs</div>
        <div class="logo-sub">Панель управления</div>
      </div>
    </div>
    <button class="btn btn-secondary btn-sm" onclick="logout()">Выйти</button>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="switchTab('clients')" id="tab-clients">Клиенты</div>
    <div class="tab" onclick="switchTab('new')" id="tab-new">Новый клиент</div>
    <div class="tab" onclick="switchTab('report')" id="tab-report">Отчёт</div>
    <div class="tab" onclick="switchTab('ai')" id="tab-ai">AI Настройки</div>
    <div class="tab" onclick="switchTab('devices')" id="tab-devices">Устройства</div>
    <div class="tab" onclick="switchTab('updates')" id="tab-updates">Обновления</div>
    <div class="tab" onclick="switchTab('onec')" id="tab-onec">1С Маппинги</div>
  </div>

  <!-- Tab: Clients -->
  <div id="tabContent-clients">
    <div class="stats" id="statsRow"></div>
    <div class="card">
      <div class="card-title">Все клиенты</div>
      <div class="toolbar">
        <input type="text" class="search-box" id="clientSearch" placeholder="Поиск по имени, key_id, тарифу..." oninput="renderClients()">
        <select class="sort-select" id="clientSort" onchange="renderClients()">
          <option value="created_desc">Сначала новые</option>
          <option value="created_asc">Сначала старые</option>
          <option value="customer_asc">Имя (А-Я)</option>
          <option value="customer_desc">Имя (Я-А)</option>
          <option value="expiry_asc">Срок: скоро истекают</option>
          <option value="expiry_desc">Срок: долго действуют</option>
          <option value="price_desc">Цена: дороже</option>
          <option value="price_asc">Цена: дешевле</option>
          <option value="ai_cost_desc">Расход ИИ: больше</option>
        </select>
      </div>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Клиент</th>
              <th>Тип</th>
              <th>Тариф</th>
              <th>Срок</th>
              <th>Активаций</th>
              <th>Пользователи</th>
              <th>Цена</th>
              <th>Бюджет ИИ</th>
              <th>Потрачено</th>
              <th>Статус</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody id="clientsTable"></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Tab: New Client -->
  <div id="tabContent-new" class="hidden">
    <div class="card">
      <div class="card-title">Создание нового клиента</div>
      <div class="form-grid">
        <div class="form-group full">
          <label>Наименование клиента *</label>
          <input type="text" id="f_customer" placeholder="ООО Ромашка или ИП Иванов И.И.">
        </div>
        <div class="form-group">
          <label>Тип клиента</label>
          <select id="f_customerType">
            <option value="individual">ИП (индивидуальный предприниматель)</option>
            <option value="small" selected>Малая организация (до 50 чел.)</option>
            <option value="large">Крупная организация (50+ чел.)</option>
          </select>
        </div>
        <div class="form-group">
          <label>Тариф</label>
          <select id="f_plan">
            <option value="trial">Trial (тест, 14 дней)</option>
            <option value="small" selected>Small (малый, 200K токенов/мес)</option>
            <option value="large">Large (крупный, 1M токенов/мес)</option>
            <option value="staff">Staff (сотрудник, безлимит)</option>
          </select>
        </div>
        <div class="form-group">
          <label>Срок действия (дней)</label>
          <input type="number" id="f_days" value="30" placeholder="30, 90, 365...">
          <small style="color: #71717a;">Для Staff — не учитывается (безлимит)</small>
        </div>
        <div class="form-group">
          <label>Цена подписки (₽)</label>
          <input type="number" id="f_price" value="0" step="100" placeholder="Сколько клиент заплатил">
        </div>
        <div class="form-group">
          <label>Бюджет на ИИ (₽)</label>
          <input type="number" id="f_aiBudget" value="0" step="100" placeholder="Сколько выделяем на токены">
          <small style="color: #71717a;">0 = безлимит по тарифу</small>
        </div>
        <div class="form-group">
          <label>Количество пользователей</label>
          <input type="number" id="f_maxActivations" value="1" min="1" placeholder="Сколько ПК смогут активировать ключ">
          <small style="color: #71717a;">Например: 4 бухгалтера = 4</small>
        </div>
        <div class="form-group full">
          <label>Примечание</label>
          <textarea id="f_note" placeholder="Комментарий к клиенту..."></textarea>
        </div>
      </div>
      <div id="genError" class="error hidden" style="margin-top: 16px;"></div>
      <div id="genSuccess" class="success hidden" style="margin-top: 16px;"></div>
      <div id="genResult" class="hidden" style="margin-top: 20px;">
        <div class="card" style="background: #0f1117;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <strong>Лицензионный ключ:</strong>
            <button class="btn btn-secondary btn-sm" onclick="copyKey()">Копировать</button>
          </div>
          <div class="key-box" id="generatedKey" onclick="copyKey()"></div>
          <small style="color: #71717a;">Передайте этот ключ клиенту для активации программы.</small>
        </div>
      </div>
      <div style="margin-top: 20px;">
        <button class="btn btn-primary" onclick="generateLicense()">Сгенерировать ключ</button>
        <button class="btn btn-secondary" onclick="resetForm()">Очистить</button>
      </div>
    </div>
  </div>

  <!-- Tab: Report -->
  <div id="tabContent-report" class="hidden">
    <div class="stats" id="reportStats"></div>
    <div class="card">
      <div class="card-title">Использование по клиентам</div>
      <div class="toolbar">
        <input type="text" class="search-box" id="reportSearch" placeholder="Поиск по имени клиента..." oninput="renderReport()">
        <select class="sort-select" id="reportSort" onchange="renderReport()">
          <option value="week_cost_desc">Стоимость за неделю: больше</option>
          <option value="week_cost_asc">Стоимость за неделю: меньше</option>
          <option value="month_cost_desc">Стоимость за месяц: больше</option>
          <option value="month_cost_asc">Стоимость за месяц: меньше</option>
          <option value="week_tokens_desc">Токенов за неделю: больше</option>
          <option value="customer_asc">Имя (А-Я)</option>
          <option value="days_asc">Скоро истекают</option>
        </select>
      </div>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Клиент</th>
              <th>Токенов (неделя)</th>
              <th>Стоимость (неделя)</th>
              <th>Токенов (месяц)</th>
              <th>Стоимость (месяц)</th>
              <th>Дней осталось</th>
            </tr>
          </thead>
          <tbody id="reportTable"></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Tab: AI Settings -->
  <div id="tabContent-ai" class="hidden">
    <div class="card">
      <div class="card-title">API ключи провайдеров AI</div>
      <p style="color:#a1a1aa;font-size:13px;margin-bottom:16px;">Ключи хранятся только на сервере. Клиенты получают доступ через прокси и никогда не видят ключи.</p>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Провайдер</th>
              <th>Метка</th>
              <th>Endpoint</th>
              <th>API ключ</th>
              <th>Активен</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody id="aiProvidersTable"></tbody>
        </table>
      </div>
      <div style="margin-top:20px;">
        <h3 style="font-size:16px;margin-bottom:12px;">Добавить/изменить провайдера</h3>
        <div class="form-grid">
          <div class="form-group">
            <label>Провайдер</label>
            <select id="ai_provider">
              <option value="tsar">ЦАРЬ РОУТЕР (OCR)</option>
              <option value="gigachat">GigaChat (структурирование)</option>
              <option value="mistral-direct">Mistral Direct (OCR)</option>
              <option value="routerai">RouterAI (Mistral через РФ-карты)</option>
            </select>
          </div>
          <div class="form-group">
            <label>Метка (название)</label>
            <input type="text" id="ai_label" placeholder="Например: Основной ключ ЦАРЬ">
          </div>
          <div class="form-group full">
            <label>Endpoint (URL API)</label>
            <input type="text" id="ai_endpoint" placeholder="https://api.tsarrouter.ru/v1">
          </div>
          <div class="form-group full">
            <label>API ключ</label>
            <input type="text" id="ai_apiKey" placeholder="sk-tsar-... или другой ключ">
          </div>
        </div>
        <button class="btn btn-primary" style="margin-top:16px;" onclick="saveAiProvider()">Сохранить провайдера</button>
        <div id="aiProviderMsg" class="hidden" style="margin-top:8px;"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Глобальный конфиг AI</div>
      <div class="form-grid">
        <div class="form-group">
          <label>OCR провайдер (по умолчанию)</label>
          <select id="cfg_ocr_provider">
            <option value="tsar">ЦАРЬ РОУТЕР</option>
            <option value="mistral">Mistral</option>
            <option value="google">Google Vision</option>
          </select>
        </div>
        <div class="form-group">
          <label>OCR модель</label>
          <input type="text" id="cfg_ocr_model" placeholder="yandex/ocr-markdown">
        </div>
        <div class="form-group">
          <label>Repair OCR модель</label>
          <input type="text" id="cfg_repair_ocr_model" placeholder="deepseek-ai/DeepSeek-OCR-2">
        </div>
        <div class="form-group">
          <label>Mistral провайдер</label>
          <select id="cfg_mistral_provider">
            <option value="direct">Direct (бесплатные токены)</option>
            <option value="routerai">RouterAI (РФ-карты)</option>
          </select>
        </div>
        <div class="form-group">
          <label>Глобальный rate limit (RPM)</label>
          <input type="number" id="cfg_global_rate_limit_rpm" value="12" min="1">
        </div>
        <div class="form-group">
          <label>Прокси включён</label>
          <select id="cfg_proxy_enabled">
            <option value="true">Включён (все запросы через сервер)</option>
            <option value="false">Выключен (клиенты используют свои ключи)</option>
          </select>
        </div>
      </div>
      <button class="btn btn-primary" style="margin-top:16px;" onclick="saveAiConfig()">Сохранить конфиг</button>
      <div id="aiConfigMsg" class="hidden" style="margin-top:8px;"></div>
    </div>
  </div>

  <!-- Tab: Devices -->
  <div id="tabContent-devices" class="hidden">
    <div class="card">
      <div class="card-title">Клиентские устройства</div>
      <p style="color:#a1a1aa;font-size:13px;margin-bottom:16px;">Здесь можно установить индивидуальные rate limits для каждого ПК. Идентификация по machineId + hostname + IP.</p>
      <div class="toolbar">
        <input type="text" class="search-box" id="deviceSearch" placeholder="Поиск по hostname, IP, machineId..." oninput="renderDevices()">
      </div>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Hostname</th>
              <th>IP</th>
              <th>Machine ID</th>
              <th>Клиент</th>
              <th>Rate limit (RPM)</th>
              <th>Последняя активность</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody id="devicesTable"></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Tab: Updates -->
  <div id="tabContent-updates" class="hidden">
    <div class="card">
      <div class="card-title">Управление обновлениями</div>
      <p style="color:#a1a1aa;font-size:13px;margin-bottom:16px;">При обновлении min_required_version все клиенты увидят уведомление во весь экран. При force_update — программа заблокируется до обновления.</p>
      <div class="form-grid">
        <div class="form-group">
          <label>Текущая версия приложения</label>
          <input type="text" id="cfg_app_version" placeholder="1.0.0">
        </div>
        <div class="form-group">
          <label>Минимальная требуемая версия</label>
          <input type="text" id="cfg_min_required_version" placeholder="1.0.0">
          <small style="color:#71717a;">Клиенты с версией ниже этой увидят уведомление об обновлении</small>
        </div>
        <div class="form-group">
          <label>Принудительное обновление</label>
          <select id="cfg_force_update">
            <option value="false">Выключено (можно отложить)</option>
            <option value="true">Включено (блокировка до обновления)</option>
          </select>
        </div>
        <div class="form-group full">
          <label>URL для скачивания обновления</label>
          <input type="text" id="cfg_update_url" placeholder="https://api.zetronix.ru/releases/latest.exe">
        </div>
      </div>
      <button class="btn btn-primary" style="margin-top:16px;" onclick="saveUpdateConfig()">Сохранить</button>
      <div id="updateConfigMsg" class="hidden" style="margin-top:8px;"></div>
    </div>
  </div>

  <!-- Tab: 1C Mappings -->
  <div id="tabContent-onec" class="hidden">
    <div class="card">
      <div class="card-title">Маппинги 1С по клиентам</div>
      <p style="color:#a1a1aa;font-size:13px;margin-bottom:16px;">Для стандартных конфигураций 1С (Бухгалтерия, УТ, ERP, Комплексная) маппинг подбирается автоматически. Для кастомных — настройте вручную здесь.</p>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Клиент</th>
              <th>Key ID</th>
              <th>Тип 1С</th>
              <th>Конфигурация</th>
              <th>Источник</th>
              <th>Обновлён</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody id="onecMappingsTable"></tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Доступные пресеты</div>
      <p style="color:#a1a1aa;font-size:13px;margin-bottom:16px;">Пресеты применяются автоматически при автоопределении конфигурации 1С. Просмотр — чтобы понять, какие поля маппятся.</p>
      <div id="onecPresetsList"></div>
    </div>

    <div class="card">
      <div class="card-title">Редактор маппинга</div>
      <p style="color:#a1a1aa;font-size:13px;margin-bottom:16px;">Создать или изменить кастомный маппинг для клиента. JSON формат: { document_type_mapping, metadata_mapping, table_mapping: { tabular_section, column_mapping } }</p>
      <div class="form-grid">
        <div class="form-group">
          <label>Key ID клиента</label>
          <input type="text" id="onec_key_id" placeholder="XXXX-XXXX-XXXX-XXXX">
        </div>
        <div class="form-group">
          <label>Тип конфигурации</label>
          <select id="onec_config_type">
            <option value="custom">custom (кастомная)</option>
            <option value="accounting">accounting (Бухгалтерия)</option>
            <option value="trade">trade (УТ)</option>
            <option value="erp">erp (ERP)</option>
            <option value="complex">complex (Комплексная)</option>
          </select>
        </div>
        <div class="form-group full">
          <label>Имя конфигурации</label>
          <input type="text" id="onec_config_name" placeholder="1С:Бухгалтерия 8.3">
        </div>
        <div class="form-group full">
          <label>JSON маппинга</label>
          <textarea id="onec_mapping_json" rows="12" style="font-family:monospace;font-size:12px;" placeholder='{"document_type_mapping":{},"metadata_mapping":{},"table_mapping":{"tabular_section":"Товары","column_mapping":{}}}'></textarea>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px;">
        <button class="btn btn-primary" onclick="saveOneCMapping()">Сохранить маппинг</button>
        <button class="btn btn-secondary" onclick="loadPresetToEditor()">Загрузить пресет</button>
      </div>
      <div id="onecMappingMsg" class="hidden" style="margin-top:8px;"></div>
    </div>
  </div>
</div>

<script>
let jwtToken = localStorage.getItem('zetronix_admin_token')

// ─── Login ────────────────────────────────────────────────────────
async function doLogin() {
  const login = document.getElementById('loginInput').value.trim()
  const password = document.getElementById('passwordInput').value
  const errEl = document.getElementById('loginError')

  if (!login || !password) {
    errEl.textContent = 'Введите логин и пароль'
    errEl.classList.remove('hidden')
    return
  }

  try {
    const resp = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password })
    })
    const data = await resp.json()
    if (!resp.ok) {
      errEl.textContent = data.error || 'Ошибка входа'
      errEl.classList.remove('hidden')
      return
    }
    jwtToken = data.token
    localStorage.setItem('zetronix_admin_token', jwtToken)
    showMainApp()
  } catch (err) {
    errEl.textContent = 'Сервер недоступен: ' + err.message
    errEl.classList.remove('hidden')
  }
}

function logout() {
  jwtToken = null
  localStorage.removeItem('zetronix_admin_token')
  document.getElementById('mainApp').classList.add('hidden')
  document.getElementById('loginScreen').classList.remove('hidden')
  document.getElementById('loginInput').value = ''
  document.getElementById('passwordInput').value = ''
}

// ─── Main App ─────────────────────────────────────────────────────
async function showMainApp() {
  document.getElementById('loginScreen').classList.add('hidden')
  document.getElementById('mainApp').classList.remove('hidden')
  await loadClients()
}

function switchTab(tab) {
  document.querySelectorAll('[id^="tabContent-"]').forEach(el => el.classList.add('hidden'))
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'))
  document.getElementById('tabContent-' + tab).classList.remove('hidden')
  document.getElementById('tab-' + tab).classList.add('active')
  if (tab === 'clients') loadClients()
  if (tab === 'report') loadReport()
  if (tab === 'ai') loadAiProviders()
  if (tab === 'devices') loadDevices()
  if (tab === 'updates') loadUpdateConfig()
  if (tab === 'onec') loadOneCMappings()
}

// ─── Load clients ─────────────────────────────────────────────────
let allClients = []
let allReportData = null

async function loadClients() {
  try {
    const resp = await fetch('/api/admin/licenses/full', {
      headers: { 'Authorization': 'Bearer ' + jwtToken }
    })
    if (resp.status === 401) { logout(); return }
    const data = await resp.json()
    allClients = data.licenses || []
    renderClients()
  } catch (err) {
    document.getElementById('clientsTable').innerHTML = '<tr><td colspan="11" style="color:#ef4444;">Ошибка: ' + escapeHtml(err.message) + '</td></tr>'
  }
}

function renderClients() {
  const licenses = allClients
  const search = (document.getElementById('clientSearch')?.value || '').toLowerCase().trim()
  const sort = document.getElementById('clientSort')?.value || 'created_desc'

  // Stats (по всем данным, без фильтра)
  const total = licenses.length
  const active = licenses.filter(l => !l.revoked && (!l.expiry_date || new Date(l.expiry_date) > new Date())).length
  const totalRevenue = licenses.reduce((s, l) => s + parseFloat(l.price_rubles || 0), 0)
  const totalAiCost = licenses.reduce((s, l) => s + parseFloat(l.total_ai_cost || 0), 0)

  document.getElementById('statsRow').innerHTML = \`
    <div class="stat-card"><div class="stat-label">Всего клиентов</div><div class="stat-value">\${total}</div></div>
    <div class="stat-card"><div class="stat-label">Активных</div><div class="stat-value">\${active}</div></div>
    <div class="stat-card"><div class="stat-label">Выручка</div><div class="stat-value">₽\${totalRevenue.toLocaleString('ru-RU')}</div></div>
    <div class="stat-card"><div class="stat-label">Расход на ИИ</div><div class="stat-value">₽\${totalAiCost.toLocaleString('ru-RU', {maximumFractionDigits: 2})}</div></div>
  \`

  // Фильтр
  let filtered = licenses
  if (search) {
    filtered = licenses.filter(l =>
      (l.customer || '').toLowerCase().includes(search) ||
      (l.key_id || '').toLowerCase().includes(search) ||
      (l.plan || '').toLowerCase().includes(search) ||
      (l.customer_type || '').toLowerCase().includes(search)
    )
  }

  // Сортировка
  const sorters = {
    created_desc: (a, b) => new Date(b.created_at) - new Date(a.created_at),
    created_asc: (a, b) => new Date(a.created_at) - new Date(b.created_at),
    customer_asc: (a, b) => (a.customer || '').localeCompare(b.customer || '', 'ru'),
    customer_desc: (a, b) => (b.customer || '').localeCompare(a.customer || '', 'ru'),
    expiry_asc: (a, b) => {
      const av = a.unlimited ? Infinity : (a.expiry_date ? new Date(a.expiry_date) : new Date(0))
      const bv = b.unlimited ? Infinity : (b.expiry_date ? new Date(b.expiry_date) : new Date(0))
      return av - bv
    },
    expiry_desc: (a, b) => {
      const av = a.unlimited ? Infinity : (a.expiry_date ? new Date(a.expiry_date) : new Date(0))
      const bv = b.unlimited ? Infinity : (b.expiry_date ? new Date(b.expiry_date) : new Date(0))
      return bv - av
    },
    price_desc: (a, b) => parseFloat(b.price_rubles || 0) - parseFloat(a.price_rubles || 0),
    price_asc: (a, b) => parseFloat(a.price_rubles || 0) - parseFloat(b.price_rubles || 0),
    ai_cost_desc: (a, b) => parseFloat(b.total_ai_cost || 0) - parseFloat(a.total_ai_cost || 0),
  }
  filtered.sort(sorters[sort] || sorters.created_desc)

  // Table
  const typeLabels = { individual: 'ИП', small: 'Малая', large: 'Крупная' }
  const planLabels = { trial: 'Trial', small: 'Small', large: 'Large', staff: 'Staff' }

  document.getElementById('clientsTable').innerHTML = filtered.map(l => {
    const isExpired = l.expiry_date && new Date(l.expiry_date) < new Date()
    const isRevoked = l.revoked
    const statusBadge = isRevoked
      ? '<span class="badge badge-red">Отозвана</span>'
      : isExpired
      ? '<span class="badge badge-gray">Истекла</span>'
      : l.unlimited
      ? '<span class="badge badge-blue">Безлимит</span>'
      : '<span class="badge badge-green">Активна</span>'

    const expiryText = l.unlimited ? '∞' : (l.expiry_date ? new Date(l.expiry_date).toLocaleDateString('ru-RU') : '—')
    const budget = parseFloat(l.ai_budget_rubles || 0)
    const spent = parseFloat(l.total_ai_cost || 0)
    const budgetText = budget > 0
      ? \`₽\${spent.toLocaleString('ru-RU', {maximumFractionDigits:0})} / ₽\${budget.toLocaleString('ru-RU')}\`
      : \`₽\${spent.toLocaleString('ru-RU', {maximumFractionDigits:0})}\`

    return \`<tr>
      <td><strong>\${escapeHtml(l.customer)}</strong><br><small style="color:#71717a">\${l.key_id}</small></td>
      <td>\${typeLabels[l.customer_type] || '—'}</td>
      <td><span class="badge badge-blue">\${planLabels[l.plan] || l.plan}</span></td>
      <td>\${expiryText}</td>
      <td>\${l.activations_count || 0}</td>
      <td>\${l.activations_count || 0} / \${l.max_activations || 1} <button class="btn btn-secondary btn-sm" style="margin-left:4px;padding:2px 8px;" onclick="changeActivations('\${l.key_id}', '\${escapeHtml(l.customer)}', \${l.max_activations || 1}, \${l.activations_count || 0})">Изменить</button></td>
      <td>₽\${parseFloat(l.price_rubles || 0).toLocaleString('ru-RU')}</td>
      <td>\${budgetText}</td>
      <td>\${budget > 0 ? renderProgress(spent, budget) : '—'}</td>
      <td>\${statusBadge}</td>
      <td class="row-actions">
        <button class="btn btn-secondary btn-sm" onclick="showKey('\${l.key_id}')">Ключ</button>
        <button class="btn btn-secondary btn-sm" onclick="showActivations('\${l.key_id}', '\${escapeHtml(l.customer)}')">Устройства</button>
        \${!isRevoked && !l.unlimited ? \`<button class="btn btn-primary btn-sm" onclick="extendLicense('\${l.key_id}', '\${escapeHtml(l.customer)}')">Продлить</button>\` : ''}
        \${!isRevoked ? \`<button class="btn btn-danger btn-sm" onclick="revokeLicense('\${l.key_id}')">Отозвать</button>\` : ''}
        <button class="btn btn-danger btn-sm" onclick="deleteClient('\${l.key_id}', '\${escapeHtml(l.customer)}')" style="background:#7f1d1d;">Удалить</button>
      </td>
    </tr>\`
  }).join('') || '<tr><td colspan="11" style="text-align:center;color:#71717a;padding:40px;">Ничего не найдено</td></tr>'
}

function renderProgress(spent, budget) {
  const pct = Math.min(100, (spent / budget) * 100)
  const cls = pct > 90 ? 'danger' : pct > 70 ? 'warn' : ''
  return \`<div>₽\${spent.toLocaleString('ru-RU', {maximumFractionDigits:0})} / ₽\${budget.toLocaleString('ru-RU')} (\${pct.toFixed(0)}%)</div><div class="progress"><div class="progress-bar \${cls}" style="width:\${pct}%"></div></div>\`
}

// ─── Generate license ─────────────────────────────────────────────
async function generateLicense() {
  const customer = document.getElementById('f_customer').value.trim()
  const errEl = document.getElementById('genError')
  const successEl = document.getElementById('genSuccess')
  const resultEl = document.getElementById('genResult')

  errEl.classList.add('hidden')
  successEl.classList.add('hidden')
  resultEl.classList.add('hidden')

  if (!customer) {
    errEl.textContent = 'Укажите наименование клиента'
    errEl.classList.remove('hidden')
    return
  }

  const plan = document.getElementById('f_plan').value
  const unlimited = plan === 'staff'

  try {
    const resp = await fetch('/api/admin/generate-license', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwtToken },
      body: JSON.stringify({
        customer,
        customerType: document.getElementById('f_customerType').value,
        plan,
        days: document.getElementById('f_days').value,
        unlimited,
        priceRubles: document.getElementById('f_price').value,
        aiBudgetRubles: document.getElementById('f_aiBudget').value,
        adminNote: document.getElementById('f_note').value,
        maxActivations: document.getElementById('f_maxActivations').value,
      })
    })
    const data = await resp.json()
    if (!resp.ok) {
      errEl.textContent = data.error || 'Ошибка генерации'
      errEl.classList.remove('hidden')
      return
    }
    successEl.textContent = 'Лицензия создана и сохранена в БД!'
    successEl.classList.remove('hidden')
    resultEl.classList.remove('hidden')
    document.getElementById('generatedKey').textContent = data.licenseKey
  } catch (err) {
    errEl.textContent = 'Сервер недоступен: ' + err.message
    errEl.classList.remove('hidden')
  }
}

function copyToClipboard(text) {
  // Современный API (работает на HTTPS/localhost)
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
    return
  }
  fallbackCopy(text)
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try { document.execCommand('copy') } catch (e) {}
  document.body.removeChild(ta)
}

function copyKey() {
  const key = document.getElementById('generatedKey').textContent
  copyToClipboard(key)
  const btn = event.target
  const orig = btn.textContent
  btn.textContent = 'Скопировано!'
  setTimeout(() => btn.textContent = orig, 2000)
}

function resetForm() {
  document.getElementById('f_customer').value = ''
  document.getElementById('f_days').value = '30'
  document.getElementById('f_price').value = '0'
  document.getElementById('f_aiBudget').value = '0'
  document.getElementById('f_maxActivations').value = '1'
  document.getElementById('f_note').value = ''
  document.getElementById('genError').classList.add('hidden')
  document.getElementById('genSuccess').classList.add('hidden')
  document.getElementById('genResult').classList.add('hidden')
}

// ─── Show key ─────────────────────────────────────────────────────
async function showKey(keyId) {
  try {
    const resp = await fetch('/api/admin/licenses/full', {
      headers: { 'Authorization': 'Bearer ' + jwtToken }
    })
    const data = await resp.json()
    const lic = (data.licenses || []).find(l => l.key_id === keyId)
    if (lic) {
      showKeyModal(lic.license_key, lic.customer)
    } else {
      alert('Ключ не найден')
    }
  } catch (err) {
    alert('Ошибка: ' + err.message)
  }
}

function showKeyModal(licenseKey, customer) {
  const modal = document.createElement('div')
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:1000;'
  modal.innerHTML = \`
    <div style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:24px;max-width:700px;width:90%;max-height:80vh;overflow:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <div>
          <strong style="font-size:16px;">Лицензионный ключ</strong>
          <div style="color:#71717a;font-size:13px;">\${escapeHtml(customer)}</div>
        </div>
        <button onclick="this.closest('div[style*=fixed]').remove()" style="background:none;border:none;color:#71717a;font-size:24px;cursor:pointer;">×</button>
      </div>
      <textarea id="modalKeyText" style="width:100%;height:120px;background:#0f1117;border:1px solid #3f3f46;border-radius:8px;color:#e4e4e7;padding:12px;font-family:monospace;font-size:11px;resize:vertical;" readonly>\${licenseKey}</textarea>
      <div style="display:flex;gap:8px;margin-top:16px;">
        <button class="btn btn-primary" onclick="copyToClipboard(document.getElementById('modalKeyText').value); this.textContent='Скопировано!'; setTimeout(() => this.textContent='Копировать', 2000)">Копировать</button>
        <button class="btn btn-secondary" onclick="this.closest('div[style*=fixed]').remove()">Закрыть</button>
      </div>
    </div>
  \`
  document.body.appendChild(modal)
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove() })
}

// ─── Revoke ───────────────────────────────────────────────────────
async function revokeLicense(keyId) {
  if (!confirm('Отозвать лицензию ' + keyId + '? Клиент больше не сможет пользоваться программой.')) return
  try {
    await fetch('/api/admin/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwtToken },
      body: JSON.stringify({ keyId })
    })
    await loadClients()
  } catch (err) {
    alert('Ошибка: ' + err.message)
  }
}

// ─── Delete client (полное удаление из БД) ────────────────────────
async function deleteClient(keyId, customer) {
  if (!confirm(
    'УДАЛИТЬ клиента: ' + customer + '?\\n\\n' +
    'Это действие НЕОБРАТИМО!\\n' +
    'Будут удалены: лицензия, все активации, вся статистика использования.\\n\\n' +
    'Нажмите ОК для подтверждения.'
  )) return

  // Двойное подтверждение
  if (!confirm('Точно удалить? Это нельзя отменить!')) return

  try {
    const resp = await fetch('/api/admin/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwtToken },
      body: JSON.stringify({ keyId })
    })
    const data = await resp.json()
    if (!resp.ok) {
      alert(data.error || 'Ошибка удаления')
      return
    }
    alert(data.message)
    await loadClients()
  } catch (err) {
    alert('Ошибка: ' + err.message)
  }
}

// ─── Extend license (продление) ───────────────────────────────────
// ─── Change activations count ─────────────────────────────────────
function changeActivations(keyId, customer, currentMax, currentActive) {
  const input = prompt(
    'Изменение числа пользователей для: ' + customer + '\\n\\n' +
    'Текущий лимит: ' + currentMax + '\\n' +
    'Активировано: ' + currentActive + '\\n\\n' +
    'Введите новый лимит пользователей:',
    currentMax
  )
  if (input === null) return
  const newMax = parseInt(input)
  if (!newMax || newMax < 1) {
    alert('Введите число больше 0')
    return
  }
  doChangeActivations(keyId, newMax)
}

async function doChangeActivations(keyId, newMax) {
  try {
    const resp = await fetch('/api/admin/set-activations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwtToken },
      body: JSON.stringify({ keyId, maxActivations: newMax })
    })
    const data = await resp.json()
    if (!resp.ok || !data.success) {
      alert(data.error || data.message || 'Ошибка')
      return
    }
    alert(data.message)
    await loadClients()
  } catch (err) {
    alert('Ошибка: ' + err.message)
  }
}

// ─── Show activations (devices) ───────────────────────────────────
async function showActivations(keyId, customer) {
  try {
    const resp = await fetch('/api/admin/activations/' + keyId, {
      headers: { 'Authorization': 'Bearer ' + jwtToken }
    })
    const data = await resp.json()
    const activations = data.activations || []

    const rows = activations.map(a => \`<tr>
      <td style="font-family:monospace;font-size:11px;">\${escapeHtml(a.machine_id)}</td>
      <td>\${new Date(a.activated_at).toLocaleString('ru-RU')}</td>
      <td>\${new Date(a.last_seen).toLocaleString('ru-RU')}</td>
      <td><button class="btn btn-danger btn-sm" onclick="deactivateDevice('\${keyId}', '\${escapeHtml(a.machine_id)}')">Отключить</button></td>
    </tr>\`).join('') || '<tr><td colspan="4" style="text-align:center;color:#71717a;padding:20px;">Нет активированных устройств</td></tr>'

    const modal = document.createElement('div')
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:1000;'
    modal.innerHTML = \`
      <div style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:24px;max-width:700px;width:90%;max-height:80vh;overflow:auto;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <div>
            <strong style="font-size:16px;">Устройства клиента</strong>
            <div style="color:#71717a;font-size:13px;">\${escapeHtml(customer)} (\${activations.length} актив.)</div>
          </div>
          <button onclick="this.closest('div[style*=fixed]').remove()" style="background:none;border:none;color:#71717a;font-size:24px;cursor:pointer;">×</button>
        </div>
        <table style="width:100%;">
          <thead><tr><th style="text-align:left;padding:8px;">Устройство</th><th style="text-align:left;padding:8px;">Активирован</th><th style="text-align:left;padding:8px;">Последняя активность</th><th></th></tr></thead>
          <tbody>\${rows}</tbody>
        </table>
        <div style="margin-top:16px;display:flex;gap:8px;">
          <button class="btn btn-secondary" onclick="this.closest('div[style*=fixed]').remove()">Закрыть</button>
        </div>
      </div>
    \`
    document.body.appendChild(modal)
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove() })
  } catch (err) {
    alert('Ошибка: ' + err.message)
  }
}

async function deactivateDevice(keyId, machineId) {
  if (!confirm('Отключить устройство ' + machineId + '?\\nПользователь будет выброшен на экран активации при следующей проверке.')) return
  try {
    await fetch('/api/admin/deactivate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwtToken },
      body: JSON.stringify({ keyId, machineId })
    })
    showActivations(keyId, '')
    await loadClients()
  } catch (err) {
    alert('Ошибка: ' + err.message)
  }
}

function extendLicense(keyId, customer) {
  // Модальное окно через prompt (простой вариант)
  const days = prompt('Продление лицензии для: ' + customer + '\\n\\nНа сколько дней продлить?\\n(30 = месяц, 90 = квартал, 365 = год)', '30')
  if (!days) return

  const price = prompt('Сколько клиент заплатил за продление? (₽)\\n(0 = бесплатно)', '0')
  if (price === null) return

  const budget = prompt('Добавить бюджет на ИИ? (₽)\\n(0 = не добавлять)', '0')
  if (budget === null) return

  doExtend(keyId, parseInt(days), parseFloat(price) || 0, parseFloat(budget) || 0)
}

async function doExtend(keyId, addDays, addPrice, addBudget) {
  try {
    const resp = await fetch('/api/admin/extend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwtToken },
      body: JSON.stringify({
        keyId,
        addDays,
        addPriceRubles: addPrice,
        addAiBudgetRubles: addBudget,
      })
    })
    const data = await resp.json()
    if (!resp.ok) {
      alert('Ошибка: ' + (data.error || 'неизвестная'))
      return
    }
    alert(data.message)
    await loadClients()
  } catch (err) {
    alert('Ошибка: ' + err.message)
  }
}

// ─── Report ───────────────────────────────────────────────────────
async function loadReport() {
  try {
    const resp = await fetch('/api/admin/report', {
      headers: { 'Authorization': 'Bearer ' + jwtToken }
    })
    if (resp.status === 401) { logout(); return }
    allReportData = await resp.json()
    renderReport()
  } catch (err) {
    document.getElementById('reportTable').innerHTML = '<tr><td colspan="6" style="color:#ef4444;">Ошибка: ' + escapeHtml(err.message) + '</td></tr>'
  }
}

function renderReport() {
  if (!allReportData) return
  const data = allReportData
  const search = (document.getElementById('reportSearch')?.value || '').toLowerCase().trim()
  const sort = document.getElementById('reportSort')?.value || 'week_cost_desc'

  const t = data.totals || {}
  document.getElementById('reportStats').innerHTML = \`
    <div class="stat-card"><div class="stat-label">Токенов за неделю</div><div class="stat-value">\${formatNum(t.week_total_tokens)}</div></div>
    <div class="stat-card"><div class="stat-label">Стоимость за неделю</div><div class="stat-value">₽\${formatNum(t.week_total_cost)}</div></div>
    <div class="stat-card"><div class="stat-label">Токенов за месяц</div><div class="stat-value">\${formatNum(t.month_total_tokens)}</div></div>
    <div class="stat-card"><div class="stat-label">Стоимость за месяц</div><div class="stat-value">₽\${formatNum(t.month_total_cost)}</div></div>
  \`

  let customers = data.customers || []
  if (search) {
    customers = customers.filter(c => (c.customer || '').toLowerCase().includes(search))
  }

  const sorters = {
    week_cost_desc: (a, b) => parseFloat(b.week_cost || 0) - parseFloat(a.week_cost || 0),
    week_cost_asc: (a, b) => parseFloat(a.week_cost || 0) - parseFloat(b.week_cost || 0),
    month_cost_desc: (a, b) => parseFloat(b.month_cost || 0) - parseFloat(a.month_cost || 0),
    month_cost_asc: (a, b) => parseFloat(a.month_cost || 0) - parseFloat(b.month_cost || 0),
    week_tokens_desc: (a, b) => parseFloat(b.week_tokens || 0) - parseFloat(a.week_tokens || 0),
    customer_asc: (a, b) => (a.customer || '').localeCompare(b.customer || '', 'ru'),
    days_asc: (a, b) => {
      const av = a.days_remaining === null ? Infinity : parseFloat(a.days_remaining)
      const bv = b.days_remaining === null ? Infinity : parseFloat(b.days_remaining)
      return av - bv
    },
  }
  customers.sort(sorters[sort] || sorters.week_cost_desc)

  const rows = customers.map(c => \`<tr>
    <td><strong>\${escapeHtml(c.customer)}</strong></td>
    <td>\${formatNum(c.week_tokens)}</td>
    <td>₽\${formatNum(c.week_cost)}</td>
    <td>\${formatNum(c.month_tokens)}</td>
    <td>₽\${formatNum(c.month_cost)}</td>
    <td>\${c.days_remaining !== null ? Math.round(c.days_remaining) + ' дн.' : '∞'}</td>
  </tr>\`).join('')

  document.getElementById('reportTable').innerHTML = rows || '<tr><td colspan="6" style="text-align:center;color:#71717a;padding:40px;">Ничего не найдено</td></tr>'
}

// ─── AI Providers ─────────────────────────────────────────────────
let allAiProviders = []

async function loadAiProviders() {
  try {
    const resp = await fetch('/api/admin/ai-providers', {
      headers: { 'Authorization': 'Bearer ' + jwtToken }
    })
    if (resp.status === 401) { logout(); return }
    const data = await resp.json()
    allAiProviders = data.providers || []
    renderAiProviders()
    await loadAiConfig()
  } catch (err) {
    document.getElementById('aiProvidersTable').innerHTML = '<tr><td colspan="6" style="color:#ef4444;">Ошибка: ' + escapeHtml(err.message) + '</td></tr>'
  }
}

function renderAiProviders() {
  const providerLabels = {
    'tsar': 'ЦАРЬ РОУТЕР',
    'gigachat': 'GigaChat',
    'mistral-direct': 'Mistral Direct',
    'routerai': 'RouterAI',
  }
  document.getElementById('aiProvidersTable').innerHTML = allAiProviders.map(p => {
    const keyPreview = p.api_key ? p.api_key.substring(0, 8) + '••••••••' : '—'
    return \`<tr>
      <td><strong>\${providerLabels[p.provider] || p.provider}</strong></td>
      <td>\${escapeHtml(p.label)}</td>
      <td style="font-size:11px;color:#a1a1aa;">\${escapeHtml(p.endpoint)}</td>
      <td style="font-family:monospace;font-size:11px;">\${keyPreview}</td>
      <td>\${p.is_active ? '<span class="badge badge-green">Активен</span>' : '<span class="badge badge-gray">Выключен</span>'}</td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteAiProvider(\${p.id})">Удалить</button></td>
    </tr>\`
  }).join('') || '<tr><td colspan="6" style="text-align:center;color:#71717a;padding:20px;">Нет провайдеров. Добавьте ниже.</td></tr>'
}

async function saveAiProvider() {
  const provider = document.getElementById('ai_provider').value
  const label = document.getElementById('ai_label').value
  const endpoint = document.getElementById('ai_endpoint').value
  const apiKey = document.getElementById('ai_apiKey').value
  const msgEl = document.getElementById('aiProviderMsg')

  if (!endpoint || !apiKey) {
    msgEl.textContent = 'Заполните endpoint и API ключ'
    msgEl.className = 'error'
    msgEl.classList.remove('hidden')
    return
  }

  try {
    const resp = await fetch('/api/admin/ai-providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwtToken },
      body: JSON.stringify({ provider, label, apiKey, endpoint, isActive: true })
    })
    const data = await resp.json()
    if (!resp.ok) {
      msgEl.textContent = data.error || 'Ошибка'
      msgEl.className = 'error'
      msgEl.classList.remove('hidden')
      return
    }
    msgEl.textContent = 'Провайдер сохранён!'
    msgEl.className = 'success'
    msgEl.classList.remove('hidden')
    document.getElementById('ai_label').value = ''
    document.getElementById('ai_apiKey').value = ''
    await loadAiProviders()
  } catch (err) {
    msgEl.textContent = 'Ошибка: ' + err.message
    msgEl.className = 'error'
    msgEl.classList.remove('hidden')
  }
}

async function deleteAiProvider(id) {
  if (!confirm('Удалить провайдера?')) return
  try {
    await fetch('/api/admin/ai-providers/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwtToken },
      body: JSON.stringify({ id })
    })
    await loadAiProviders()
  } catch (err) {
    alert('Ошибка: ' + err.message)
  }
}

async function loadAiConfig() {
  try {
    const resp = await fetch('/api/admin/config', {
      headers: { 'Authorization': 'Bearer ' + jwtToken }
    })
    const data = await resp.json()
    const cfg = data.config || {}
    if (cfg.ocr_provider) document.getElementById('cfg_ocr_provider').value = cfg.ocr_provider
    if (cfg.ocr_model) document.getElementById('cfg_ocr_model').value = cfg.ocr_model
    if (cfg.repair_ocr_model) document.getElementById('cfg_repair_ocr_model').value = cfg.repair_ocr_model
    if (cfg.mistral_provider) document.getElementById('cfg_mistral_provider').value = cfg.mistral_provider
    if (cfg.global_rate_limit_rpm) document.getElementById('cfg_global_rate_limit_rpm').value = cfg.global_rate_limit_rpm
    if (cfg.proxy_enabled) document.getElementById('cfg_proxy_enabled').value = cfg.proxy_enabled
  } catch (err) {
    console.error('Load AI config error:', err)
  }
}

async function saveAiConfig() {
  const msgEl = document.getElementById('aiConfigMsg')
  const updates = [
    ['ocr_provider', document.getElementById('cfg_ocr_provider').value],
    ['ocr_model', document.getElementById('cfg_ocr_model').value],
    ['repair_ocr_model', document.getElementById('cfg_repair_ocr_model').value],
    ['mistral_provider', document.getElementById('cfg_mistral_provider').value],
    ['global_rate_limit_rpm', document.getElementById('cfg_global_rate_limit_rpm').value],
    ['proxy_enabled', document.getElementById('cfg_proxy_enabled').value],
  ]
  try {
    for (const [key, value] of updates) {
      await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwtToken },
        body: JSON.stringify({ key, value })
      })
    }
    msgEl.textContent = 'Конфиг сохранён! Клиенты получат обновления в течение 30 секунд.'
    msgEl.className = 'success'
    msgEl.classList.remove('hidden')
  } catch (err) {
    msgEl.textContent = 'Ошибка: ' + err.message
    msgEl.className = 'error'
    msgEl.classList.remove('hidden')
  }
}

// ─── Devices ──────────────────────────────────────────────────────
let allDevices = []

async function loadDevices() {
  try {
    const resp = await fetch('/api/admin/machines', {
      headers: { 'Authorization': 'Bearer ' + jwtToken }
    })
    if (resp.status === 401) { logout(); return }
    const data = await resp.json()
    allDevices = data.machines || []
    renderDevices()
  } catch (err) {
    document.getElementById('devicesTable').innerHTML = '<tr><td colspan="7" style="color:#ef4444;">Ошибка: ' + escapeHtml(err.message) + '</td></tr>'
  }
}

function renderDevices() {
  const search = (document.getElementById('deviceSearch')?.value || '').toLowerCase().trim()
  let filtered = allDevices
  if (search) {
    filtered = allDevices.filter(d =>
      (d.hostname || '').toLowerCase().includes(search) ||
      (d.local_ip || '').toLowerCase().includes(search) ||
      (d.machine_id || '').toLowerCase().includes(search) ||
      (d.customer || '').toLowerCase().includes(search)
    )
  }
  document.getElementById('devicesTable').innerHTML = filtered.map(d => {
    const lastSeen = d.last_seen ? new Date(d.last_seen).toLocaleString('ru-RU') : '—'
    const isOnline = d.last_seen && (Date.now() - new Date(d.last_seen).getTime() < 2 * 60 * 1000)
    return \`<tr>
      <td><strong>\${escapeHtml(d.hostname || '—')}</strong> \${isOnline ? '<span class="badge badge-green" style="margin-left:4px;">online</span>' : ''}</td>
      <td>\${escapeHtml(d.local_ip || '—')}</td>
      <td style="font-family:monospace;font-size:11px;">\${escapeHtml(d.machine_id || '').substring(0, 16)}...</td>
      <td>\${escapeHtml(d.customer || d.license_customer || '—')}</td>
      <td>
        <input type="number" value="\${d.rate_limit_rpm}" min="1" style="width:60px;padding:4px 8px;" onchange="updateRateLimit('\${d.machine_id}', this.value)">
      </td>
      <td>\${lastSeen}</td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteDevice('\${d.machine_id}')">Удалить</button></td>
    </tr>\`
  }).join('') || '<tr><td colspan="7" style="text-align:center;color:#71717a;padding:20px;">Нет устройств. Они появятся после первого запуска клиента.</td></tr>'
}

async function updateRateLimit(machineId, rpm) {
  try {
    const resp = await fetch('/api/admin/machines/rate-limit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwtToken },
      body: JSON.stringify({ machineId, rateLimitRpm: parseInt(rpm) })
    })
    const data = await resp.json()
    if (resp.ok && data.success) {
      // Silent success — no alert needed
    } else {
      alert(data.error || 'Ошибка')
    }
  } catch (err) {
    alert('Ошибка: ' + err.message)
  }
}

async function deleteDevice(machineId) {
  if (!confirm('Удалить устройство ' + machineId.substring(0, 16) + '?')) return
  try {
    await fetch('/api/admin/machines/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwtToken },
      body: JSON.stringify({ machineId })
    })
    await loadDevices()
  } catch (err) {
    alert('Ошибка: ' + err.message)
  }
}

// ─── Updates ──────────────────────────────────────────────────────
async function loadUpdateConfig() {
  try {
    const resp = await fetch('/api/admin/config', {
      headers: { 'Authorization': 'Bearer ' + jwtToken }
    })
    const data = await resp.json()
    const cfg = data.config || {}
    if (cfg.app_version) document.getElementById('cfg_app_version').value = cfg.app_version
    if (cfg.min_required_version) document.getElementById('cfg_min_required_version').value = cfg.min_required_version
    if (cfg.force_update) document.getElementById('cfg_force_update').value = cfg.force_update
    if (cfg.update_url) document.getElementById('cfg_update_url').value = cfg.update_url
  } catch (err) {
    console.error('Load update config error:', err)
  }
}

async function saveUpdateConfig() {
  const msgEl = document.getElementById('updateConfigMsg')
  const updates = [
    ['app_version', document.getElementById('cfg_app_version').value],
    ['min_required_version', document.getElementById('cfg_min_required_version').value],
    ['force_update', document.getElementById('cfg_force_update').value],
    ['update_url', document.getElementById('cfg_update_url').value],
  ]
  try {
    for (const [key, value] of updates) {
      await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwtToken },
        body: JSON.stringify({ key, value })
      })
    }
    msgEl.textContent = 'Настройки обновлений сохранены! Клиенты получат уведомление при следующем запуске.'
    msgEl.className = 'success'
    msgEl.classList.remove('hidden')
  } catch (err) {
    msgEl.textContent = 'Ошибка: ' + err.message
    msgEl.className = 'error'
    msgEl.classList.remove('hidden')
  }
}

// ─── Utils ────────────────────────────────────────────────────────
function formatNum(v) {
  if (!v || isNaN(v)) return '0'
  return parseFloat(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
}

function escapeHtml(s) {
  if (!s) return ''
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ─── 1C Mappings ───────────────────────────────────────────────────
async function loadOneCMappings() {
  try {
    const [mappingsResp, presetsResp] = await Promise.all([
      fetch('/api/admin/onec-mappings', { headers: { 'Authorization': 'Bearer ' + jwtToken } }),
      fetch('/api/admin/onec-presets', { headers: { 'Authorization': 'Bearer ' + jwtToken } })
    ])
    const mappingsData = await mappingsResp.json()
    const presetsData = await presetsResp.json()
    renderOneCMappings(mappingsData.mappings || [])
    renderOneCPresets(presetsData.presets || {})
  } catch (err) {
    console.error('1C mappings load error:', err)
  }
}

function renderOneCMappings(mappings) {
  const tbody = document.getElementById('onecMappingsTable')
  if (!mappings.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#71717a;padding:24px;">Нет сохранённых маппингов. Для стандартных 1С пресеты применяются автоматически.</td></tr>'
    return
  }
  tbody.innerHTML = mappings.map(m => {
    const source = m.mapping_json ? '<span class="badge badge-blue">кастомный</span>' : '<span class="badge badge-gray">только схема</span>'
    const configTypeBadge = m.config_type && m.config_type !== 'custom'
      ? '<span class="badge badge-green">' + escapeHtml(m.config_type) + '</span>'
      : '<span class="badge badge-yellow">custom</span>'
    return '<tr>' +
      '<td>' + escapeHtml(m.license_customer || m.customer || '—') + '</td>' +
      '<td style="font-family:monospace;font-size:11px;">' + escapeHtml(m.key_id || '—') + '</td>' +
      '<td>' + configTypeBadge + '</td>' +
      '<td>' + escapeHtml(m.config_name || '—') + '</td>' +
      '<td>' + source + '</td>' +
      '<td>' + escapeHtml(m.updated_at ? new Date(m.updated_at).toLocaleString('ru-RU') : '—') + '</td>' +
      '<td class="row-actions">' +
        '<button class="btn btn-secondary btn-sm" onclick="editOneCMapping(' + m.id + ')">Изменить</button>' +
        '<button class="btn btn-danger btn-sm" onclick="deleteOneCMapping(' + m.id + ')">Удалить</button>' +
      '</td>' +
    '</tr>'
  }).join('')
}

function renderOneCPresets(presets) {
  const container = document.getElementById('onecPresetsList')
  const html = Object.entries(presets).map(([key, p]) => {
    const docTypes = Object.entries(p.document_type_mapping || {}).map(([k, v]) => escapeHtml(k) + ' → ' + escapeHtml(v)).join(', ')
    const cols = Object.entries((p.table_mapping || {}).column_mapping || {}).map(([k, v]) => escapeHtml(k) + ' → ' + escapeHtml(v)).join(', ')
    return '<div style="background:#0f1117;border:1px solid #3f3f46;border-radius:8px;padding:16px;margin-bottom:12px;">' +
      '<div style="font-weight:600;color:#e4e4e7;margin-bottom:8px;">' + escapeHtml(p.config_name) + ' <span class="badge badge-gray" style="margin-left:8px;">' + escapeHtml(p.config_type) + '</span></div>' +
      '<div style="font-size:12px;color:#a1a1aa;margin-bottom:4px;"><strong>Типы документов:</strong> ' + docTypes + '</div>' +
      '<div style="font-size:12px;color:#a1a1aa;margin-bottom:4px;"><strong>Табличная часть:</strong> ' + escapeHtml((p.table_mapping || {}).tabular_section || '—') + '</div>' +
      '<div style="font-size:12px;color:#a1a1aa;"><strong>Колонки:</strong> ' + cols + '</div>' +
    '</div>'
  }).join('')
  container.innerHTML = html || '<p style="color:#71717a;">Пресеты не найдены</p>'
}

async function editOneCMapping(id) {
  try {
    const resp = await fetch('/api/admin/onec-mappings/' + id, { headers: { 'Authorization': 'Bearer ' + jwtToken } })
    const data = await resp.json()
    const m = data.mapping
    if (!m) return
    document.getElementById('onec_key_id').value = m.key_id || ''
    document.getElementById('onec_config_type').value = m.config_type || 'custom'
    document.getElementById('onec_config_name').value = m.config_name || ''
    if (m.mapping_json) {
      try {
        const parsed = typeof m.mapping_json === 'string' ? JSON.parse(m.mapping_json) : m.mapping_json
        document.getElementById('onec_mapping_json').value = JSON.stringify(parsed, null, 2)
      } catch {
        document.getElementById('onec_mapping_json').value = m.mapping_json
      }
    }
  } catch (err) {
    console.error('Edit 1C mapping error:', err)
  }
}

async function saveOneCMapping() {
  const keyId = document.getElementById('onec_key_id').value.trim()
  const configType = document.getElementById('onec_config_type').value
  const configName = document.getElementById('onec_config_name').value.trim()
  const mappingJsonStr = document.getElementById('onec_mapping_json').value.trim()
  const msgEl = document.getElementById('onecMappingMsg')

  if (!keyId) {
    msgEl.className = 'error'
    msgEl.textContent = 'Укажите Key ID клиента'
    msgEl.classList.remove('hidden')
    return
  }

  let mappingJson
  try {
    mappingJson = JSON.parse(mappingJsonStr)
  } catch {
    msgEl.className = 'error'
    msgEl.textContent = 'Невалидный JSON'
    msgEl.classList.remove('hidden')
    return
  }

  try {
    const resp = await fetch('/api/admin/onec-mappings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwtToken },
      body: JSON.stringify({ keyId, configType, configName, mappingJson })
    })
    const data = await resp.json()
    if (resp.ok) {
      msgEl.className = 'success'
      msgEl.textContent = 'Маппинг сохранён'
      msgEl.classList.remove('hidden')
      loadOneCMappings()
    } else {
      msgEl.className = 'error'
      msgEl.textContent = data.error || 'Ошибка сохранения'
      msgEl.classList.remove('hidden')
    }
  } catch (err) {
    msgEl.className = 'error'
    msgEl.textContent = 'Ошибка: ' + err.message
    msgEl.classList.remove('hidden')
  }
}

async function deleteOneCMapping(id) {
  if (!confirm('Удалить маппинг?')) return
  try {
    await fetch('/api/admin/onec-mappings/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwtToken },
      body: JSON.stringify({ id })
    })
    loadOneCMappings()
  } catch (err) {
    console.error('Delete 1C mapping error:', err)
  }
}

async function loadPresetToEditor() {
  const configType = document.getElementById('onec_config_type').value
  if (!configType || configType === 'custom') {
    alert('Выберите тип конфигурации (не custom) для загрузки пресета')
    return
  }
  try {
    const resp = await fetch('/api/admin/onec-presets', { headers: { 'Authorization': 'Bearer ' + jwtToken } })
    const data = await resp.json()
    const preset = (data.presets || {})[configType]
    if (preset) {
      document.getElementById('onec_mapping_json').value = JSON.stringify(preset, null, 2)
      document.getElementById('onec_config_name').value = preset.config_name || ''
    }
  } catch (err) {
    alert('Ошибка загрузки пресета: ' + err.message)
  }
}

// ─── Init ─────────────────────────────────────────────────────────
if (jwtToken) {
  // Verify token still valid
  fetch('/api/admin/licenses/full', { headers: { 'Authorization': 'Bearer ' + jwtToken } })
    .then(r => { if (r.ok) showMainApp(); else { jwtToken = null; localStorage.removeItem('zetronix_admin_token') } })
    .catch(() => {})
}

// Enter key for login
document.getElementById('passwordInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') doLogin()
})
</script>
</body>
</html>`
}

// ─── Start server ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════════╗`)
  console.log(`║  ZetronixDocs Server v1.0                           ║`)
  console.log(`║  Порт: ${PORT}                                       ║`)
  console.log(`║  Health: http://localhost:${PORT}/api/health          ║`)
  console.log(`╚══════════════════════════════════════════════════╝\n`)
})
