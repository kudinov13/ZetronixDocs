/**
 * Генерация RSA ключевой пары для подписи лицензий.
 * Запуск: npm run generate-keys
 *
 * Создаёт:
 * - keys/private_key.pem — приватный ключ (ХРАНИТЬ В СЕКРЕТЕ)
 * - keys/public_key.pem — публичный ключ (встраивается в приложение)
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const keysDir = path.join(__dirname, '..', 'keys')

// Создаём директорию для ключей
if (!fs.existsSync(keysDir)) {
  fs.mkdirSync(keysDir, { recursive: true })
}

console.log('Генерация RSA ключевой пары (2048 бит)...')

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: 'spki',
    format: 'pem',
  },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem',
  },
})

const privateKeyPath = path.join(keysDir, 'private_key.pem')
const publicKeyPath = path.join(keysDir, 'public_key.pem')

fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 })
fs.writeFileSync(publicKeyPath, publicKey)

console.log('\n✓ Приватный ключ сохранён:', privateKeyPath)
console.log('✓ Публичный ключ сохранён:', publicKeyPath)
console.log('\n⚠️  ВАЖНО:')
console.log('  - Приватный ключ храните в секрете! Никому не передавайте.')
console.log('  - Публичный ключ нужно встроить в приложение (src/lib/license.ts).')
console.log('  - Сделайте резервную копию приватного ключа.')
console.log('\nСодержимое публичного ключа для встраивания в приложение:')
console.log('---')
console.log(publicKey)
console.log('---')
