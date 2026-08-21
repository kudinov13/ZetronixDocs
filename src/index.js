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
         license_key, customer_type, price_rubles, ai_budget_rubles, admin_note)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
        l.issued_at, l.created_at,
        COUNT(DISTINCT a.machine_id) as activations_count,
        MAX(a.last_seen) as last_activity,
        COALESCE(usage.total_tokens, 0) as total_tokens_used,
        COALESCE(usage.total_cost, 0) as total_ai_cost
      FROM licenses l
      LEFT JOIN activations a ON a.license_id = l.id
      LEFT JOIN (
        SELECT key_id,
          SUM(tokens_used) as total_tokens,
          SUM(cost_rubles) as total_cost
        FROM token_usage
        GROUP BY key_id
      ) usage ON usage.key_id = l.key_id
      GROUP BY l.id
      ORDER BY l.created_at DESC
    `)
    res.json({ licenses: result.rows })
  } catch (err) {
    console.error('Licenses full error:', err)
    res.status(500).json({ error: 'Ошибка получения списка лицензий' })
  }
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
  </div>

  <!-- Tab: Clients -->
  <div id="tabContent-clients">
    <div class="stats" id="statsRow"></div>
    <div class="card">
      <div class="card-title">Все клиенты</div>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Клиент</th>
              <th>Тип</th>
              <th>Тариф</th>
              <th>Срок</th>
              <th>Активаций</th>
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
}

// ─── Load clients ─────────────────────────────────────────────────
async function loadClients() {
  try {
    const resp = await fetch('/api/admin/licenses/full', {
      headers: { 'Authorization': 'Bearer ' + jwtToken }
    })
    if (resp.status === 401) { logout(); return }
    const data = await resp.json()
    const licenses = data.licenses || []

    // Stats
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

    // Table
    const typeLabels = { individual: 'ИП', small: 'Малая', large: 'Крупная' }
    const planLabels = { trial: 'Trial', small: 'Small', large: 'Large', staff: 'Staff' }

    document.getElementById('clientsTable').innerHTML = licenses.map(l => {
      const isExpired = l.expiry_date && new Date(l.expiry_date) < new Date()
      const isRevoked = l.revoked
      const isActive = !isRevoked && !isExpired && (!l.expiry_date || l.unlimited || true)
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
        <td>₽\${parseFloat(l.price_rubles || 0).toLocaleString('ru-RU')}</td>
        <td>\${budgetText}</td>
        <td>\${budget > 0 ? renderProgress(spent, budget) : '—'}</td>
        <td>\${statusBadge}</td>
        <td class="row-actions">
          <button class="btn btn-secondary btn-sm" onclick="showKey('\${l.key_id}')">Ключ</button>
          \${!isRevoked ? \`<button class="btn btn-danger btn-sm" onclick="revokeLicense('\${l.key_id}')">Отозвать</button>\` : ''}
        </td>
      </tr>\`
    }).join('') || '<tr><td colspan="10" style="text-align:center;color:#71717a;padding:40px;">Нет клиентов</td></tr>'
  } catch (err) {
    document.getElementById('clientsTable').innerHTML = '<tr><td colspan="10" style="color:#ef4444;">Ошибка: ' + escapeHtml(err.message) + '</td></tr>'
  }
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

function copyKey() {
  const key = document.getElementById('generatedKey').textContent
  navigator.clipboard.writeText(key).then(() => {
    const btn = event.target
    const orig = btn.textContent
    btn.textContent = 'Скопировано!'
    setTimeout(() => btn.textContent = orig, 2000)
  })
}

function resetForm() {
  document.getElementById('f_customer').value = ''
  document.getElementById('f_days').value = '30'
  document.getElementById('f_price').value = '0'
  document.getElementById('f_aiBudget').value = '0'
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
      navigator.clipboard.writeText(lic.license_key).then(() => {
        alert('Ключ скопирован в буфер обмена')
      })
    }
  } catch (err) {
    alert('Ошибка: ' + err.message)
  }
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

// ─── Report ───────────────────────────────────────────────────────
async function loadReport() {
  try {
    const resp = await fetch('/api/admin/report', {
      headers: { 'Authorization': 'Bearer ' + jwtToken }
    })
    if (resp.status === 401) { logout(); return }
    const data = await resp.json()

    const t = data.totals || {}
    document.getElementById('reportStats').innerHTML = \`
      <div class="stat-card"><div class="stat-label">Токенов за неделю</div><div class="stat-value">\${formatNum(t.week_total_tokens)}</div></div>
      <div class="stat-card"><div class="stat-label">Стоимость за неделю</div><div class="stat-value">₽\${formatNum(t.week_total_cost)}</div></div>
      <div class="stat-card"><div class="stat-label">Токенов за месяц</div><div class="stat-value">\${formatNum(t.month_total_tokens)}</div></div>
      <div class="stat-card"><div class="stat-label">Стоимость за месяц</div><div class="stat-value">₽\${formatNum(t.month_total_cost)}</div></div>
    \`

    const rows = (data.customers || []).map(c => \`<tr>
      <td><strong>\${escapeHtml(c.customer)}</strong></td>
      <td>\${formatNum(c.week_tokens)}</td>
      <td>₽\${formatNum(c.week_cost)}</td>
      <td>\${formatNum(c.month_tokens)}</td>
      <td>₽\${formatNum(c.month_cost)}</td>
      <td>\${c.days_remaining !== null ? Math.round(c.days_remaining) + ' дн.' : '∞'}</td>
    </tr>\`).join('')

    document.getElementById('reportTable').innerHTML = rows || '<tr><td colspan="6" style="text-align:center;color:#71717a;padding:40px;">Нет данных</td></tr>'
  } catch (err) {
    document.getElementById('reportTable').innerHTML = '<tr><td colspan="6" style="color:#ef4444;">Ошибка: ' + escapeHtml(err.message) + '</td></tr>'
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
