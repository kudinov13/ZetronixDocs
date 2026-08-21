/**
 * Генерация лицензионного ключа.
 * Запуск: node src/generate-license.js --customer="ООО СтройИнвест" --plan=large --days=365
 *
 * Параметры:
 *   --customer   Наименование клиента (обязательно)
 *   --plan       Тариф: small | large | staff | trial (обязательно)
 *   --days       Срок действия в днях (для staff — игнорируется, безлимит)
 *   --unlimited  Безлимитный доступ (для сотрудников)
 *   --tokenLimit Лимит токенов в месяц (0 = безлимит)
 *
 * Примеры:
 *   node src/generate-license.js --customer="ООО СтройИнвест" --plan=large --days=365
 *   node src/generate-license.js --customer="ИП Иванов" --plan=small --days=30
 *   node src/generate-license.js --customer="Сотрудник Пётр" --plan=staff --unlimited
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { Pool } = require('pg')
require('dotenv').config()

function parseArgs() {
  const args = {}
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]
    if (arg.startsWith('--')) {
      const [key, ...valueParts] = arg.slice(2).split('=')
      args[key] = valueParts.join('=') || true
    }
  }
  return args
}

async function main() {
  const args = parseArgs()

  if (!args.customer || !args.plan) {
    console.error('Использование: node src/generate-license.js --customer="Имя" --plan=large --days=365')
    console.error('  --customer   Наименование клиента (обязательно)')
    console.error('  --plan       Тариф: small | large | staff | trial (обязательно)')
    console.error('  --days       Срок действия в днях')
    console.error('  --unlimited  Безлимитный доступ')
    console.error('  --tokenLimit Лимит токенов в месяц (0 = безлимит)')
    process.exit(1)
  }

  const customer = String(args.customer)
  const plan = String(args.plan)
  const unlimited = args.unlimited === true || plan === 'staff'
  const days = args.days ? parseInt(String(args.days)) : 30
  const tokenLimit = args.tokenLimit ? parseInt(String(args.tokenLimit)) : 0

  // Загружаем приватный ключ
  const privateKeyPath = path.join(__dirname, '..', 'keys', 'private_key.pem')
  if (!fs.existsSync(privateKeyPath)) {
    console.error('Приватный ключ не найден. Сначала запустите: npm run generate-keys')
    process.exit(1)
  }
  const privateKey = fs.readFileSync(privateKeyPath, 'utf8')

  // Формируем payload
  const issuedAt = new Date().toISOString()
  const keyId = crypto.randomBytes(8).toString('hex')
  let expiry = null

  if (!unlimited) {
    const expiryDate = new Date()
    expiryDate.setDate(expiryDate.getDate() + days)
    expiry = expiryDate.toISOString()
  }

  const payload = {
    customer,
    plan,
    expiry,
    unlimited,
    tokenLimit,
    issuedAt,
    keyId,
  }

  // Подписываем payload
  const payloadJson = JSON.stringify(payload)
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(payloadJson)
  sign.end()
  const signature = sign.sign(privateKey)

  // Кодируем в base64
  const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64')
  const signatureB64 = signature.toString('base64')

  // Формируем ключ
  const licenseKey = `Zetronix1.${payloadB64}.${signatureB64}`

  // Сохраняем в БД (если доступна)
  try {
    const pool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'ZetronixDocs',
      user: process.env.DB_USER || 'Zetronix',
      password: process.env.DB_PASSWORD || 'zenza_password',
    })
    await pool.query(
      `INSERT INTO licenses (key_id, customer, plan, expiry_date, unlimited, token_limit, issued_at, license_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [keyId, customer, plan, expiry, unlimited, tokenLimit, issuedAt, licenseKey]
    )
    await pool.end()
    console.log('✓ Лицензия сохранена в базе данных')
  } catch (err) {
    console.warn('⚠️  Не удалось сохранить в БД (сервер БД может быть недоступен):', err.message)
    console.warn('   Лицензионный ключ всё равно сгенерирован и выведен ниже.')
  }

  console.log('\n═══════════════════════════════════════════════════════════════')
  console.log('  ЛИЦЕНЗИОННЫЙ КЛЮЧ ZetronixDocs')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(`  Клиент:     ${customer}`)
  console.log(`  Тариф:      ${plan}`)
  console.log(`  Безлимит:   ${unlimited ? 'Да' : 'Нет'}`)
  if (expiry) {
    console.log(`  Истекает:   ${new Date(expiry).toLocaleDateString('ru-RU')} (${days} дней)`)
  } else {
    console.log(`  Истекает:   Никогда (безлимит)`)
  }
  if (tokenLimit > 0) {
    console.log(`  Лимит ток:  ${tokenLimit} в месяц`)
  }
  console.log(`  ID ключа:   ${keyId}`)
  console.log('───────────────────────────────────────────────────────────────')
  console.log('')
  console.log(licenseKey)
  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  Передайте этот ключ клиенту для активации программы.')
  console.log('═══════════════════════════════════════════════════════════════')
}

main().catch((err) => {
  console.error('Ошибка:', err)
  process.exit(1)
})
