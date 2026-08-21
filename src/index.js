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
const { Pool } = require('pg')
require('dotenv').config()

const app = express()
const PORT = process.env.PORT || 3000
const JWT_SECRET = process.env.JWT_SECRET || 'change-this'

// Middleware
app.use(cors())
app.use(express.json({ limit: '1mb' }))

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

// ─── License activation ───────────────────────────────────────────
app.post('/api/license/activate', async (req, res) => {
  const { keyId, machineId, customer } = req.body

  if (!keyId || !machineId) {
    return res.status(400).json({ error: 'Не указан keyId или machineId' })
  }

  try {
    // Проверяем, существует ли лицензия и не отозвана ли
    const licResult = await pool.query(
      'SELECT id, revoked, expiry_date, unlimited FROM licenses WHERE key_id = $1',
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

// ─── Start server ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════════╗`)
  console.log(`║  ZetronixDocs Server v1.0                           ║`)
  console.log(`║  Порт: ${PORT}                                       ║`)
  console.log(`║  Health: http://localhost:${PORT}/api/health          ║`)
  console.log(`╚══════════════════════════════════════════════════╝\n`)
})
