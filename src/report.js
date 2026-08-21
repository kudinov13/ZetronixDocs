/**
 * Еженедельный отчёт по использованию и подпискам.
 * Запуск: npm run report
 *
 * Выводит в консоль:
 * - Сводку по каждому клиенту
 * - Потраченные токены и стоимость в рублях
 * - Дней до истечения подписки
 * - Активных клиентов за неделю
 */

const { Pool } = require('pg')
require('dotenv').config()

async function main() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'ZetronixDocs',
    user: process.env.DB_USER || 'Zetronix',
    password: process.env.DB_PASSWORD || 'zenza_password',
  })

  console.log('\n╔══════════════════════════════════════════════════════════════════╗')
  console.log('║  ЕЖЕНЕДЕЛЬНЫЙ ОТЧЁТ ZetronixDocs                                    ║')
  console.log('║  Период: последние 7 дней                                        ║')
  console.log('╚══════════════════════════════════════════════════════════════════╝')
  console.log(`  Дата формирования: ${new Date().toLocaleString('ru-RU')}\n`)

  // Общие итоги
  const totals = await pool.query(`
    SELECT
      SUM(tokens_used) FILTER (WHERE recorded_at >= NOW() - INTERVAL '7 days') as week_tokens,
      SUM(cost_rubles) FILTER (WHERE recorded_at >= NOW() - INTERVAL '7 days') as week_cost,
      SUM(tokens_used) FILTER (WHERE recorded_at >= NOW() - INTERVAL '30 days') as month_tokens,
      SUM(cost_rubles) FILTER (WHERE recorded_at >= NOW() - INTERVAL '30 days') as month_cost,
      COUNT(DISTINCT customer) FILTER (WHERE recorded_at >= NOW() - INTERVAL '7 days') as active_week,
      COUNT(DISTINCT customer) FILTER (WHERE recorded_at >= NOW() - INTERVAL '30 days') as active_month
    FROM token_usage
  `)

  const t = totals.rows[0]
  console.log('─── ОБЩИЕ ИТОГИ ────────────────────────────────────────────────────')
  console.log(`  Активных клиентов за неделю:  ${t.active_week || 0}`)
  console.log(`  Активных клиентов за месяц:   ${t.active_month || 0}`)
  console.log(`  Токенов за неделю:            ${Number(t.week_tokens || 0).toLocaleString('ru-RU')}`)
  console.log(`  Стоимость за неделю:          ${Number(t.week_cost || 0).toLocaleString('ru-RU')} ₽`)
  console.log(`  Токенов за месяц:             ${Number(t.month_tokens || 0).toLocaleString('ru-RU')}`)
  console.log(`  Стоимость за месяц:           ${Number(t.month_cost || 0).toLocaleString('ru-RU')} ₽`)
  console.log('')

  // Детализация по клиентам
  const customers = await pool.query(`
    SELECT
      l.customer,
      l.plan,
      l.unlimited,
      l.expiry_date,
      l.revoked,
      l.token_limit,
      COALESCE(usage.week_tokens, 0) as week_tokens,
      COALESCE(usage.week_cost, 0) as week_cost,
      COALESCE(usage.month_tokens, 0) as month_tokens,
      COALESCE(usage.month_cost, 0) as month_cost,
      CASE
        WHEN l.unlimited THEN '∞'
        WHEN l.expiry_date IS NULL THEN '—'
        WHEN l.expiry_date < NOW() THEN 'ИСТЁК'
        ELSE EXTRACT(DAY FROM l.expiry_date - NOW())::text
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
    ORDER BY l.customer
  `)

  console.log('─── ДЕТАЛИЗАЦИЯ ПО КЛИЕНТАМ ────────────────────────────────────────')
  console.log('  Клиент                    | Тариф     | Дней | Токенов/нед | ₽/нед    | Токенов/мес | ₽/мес')
  console.log('  ──────────────────────────┼───────────┼──────┼─────────────┼──────────┼─────────────┼──────────')

  for (const c of customers.rows) {
    const name = c.customer.length > 25 ? c.customer.substring(0, 25) : c.customer.padEnd(25)
    const plan = (c.plan || '').padEnd(9)
    const days = String(c.days_remaining).padEnd(6)
    const weekTokens = Number(c.week_tokens).toLocaleString('ru-RU').padEnd(11)
    const weekCost = (Number(c.week_cost).toLocaleString('ru-RU') + ' ₽').padEnd(8)
    const monthTokens = Number(c.month_tokens).toLocaleString('ru-RU').padEnd(11)
    const monthCost = (Number(c.month_cost).toLocaleString('ru-RU') + ' ₽').padEnd(8)
    const revokedTag = c.revoked ? ' [ОТЗВАН]' : ''
    console.log(`  ${name} | ${plan} | ${days} | ${weekTokens} | ${weekCost} | ${monthTokens} | ${monthCost}${revokedTag}`)
  }

  console.log('')
  console.log('─── КЛИЕНТЫ С ИСТЕКАЮЩЕЙ ПОДПИСКОЙ (≤7 дней) ──────────────────────')

  const expiring = await pool.query(`
    SELECT customer, plan, expiry_date,
      EXTRACT(DAY FROM expiry_date - NOW())::int as days_left
    FROM licenses
    WHERE revoked = FALSE
      AND unlimited = FALSE
      AND expiry_date IS NOT NULL
      AND expiry_date > NOW()
      AND expiry_date <= NOW() + INTERVAL '7 days'
    ORDER BY expiry_date ASC
  `)

  if (expiring.rows.length === 0) {
    console.log('  Нет клиентов с истекающей подпиской.')
  } else {
    for (const e of expiring.rows) {
      console.log(`  ${e.customer} (${e.plan}) — истекает через ${e.days_left} дн. (${new Date(e.expiry_date).toLocaleDateString('ru-RU')})`)
    }
  }

  console.log('')
  console.log('─── КЛИЕНТЫ С ИСТЕКШЕЙ ПОДПИСКОЙ ──────────────────────────────────')

  const expired = await pool.query(`
    SELECT customer, plan, expiry_date
    FROM licenses
    WHERE revoked = FALSE
      AND unlimited = FALSE
      AND expiry_date IS NOT NULL
      AND expiry_date < NOW()
    ORDER BY expiry_date DESC
  `)

  if (expired.rows.length === 0) {
    console.log('  Нет клиентов с истекшей подпиской.')
  } else {
    for (const e of expired.rows) {
      console.log(`  ${e.customer} (${e.plan}) — истекла ${new Date(e.expiry_date).toLocaleDateString('ru-RU')}`)
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════\n')

  await pool.end()
}

main().catch((err) => {
  console.error('Ошибка отчёта:', err.message)
  process.exit(1)
})
