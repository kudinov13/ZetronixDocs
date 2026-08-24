/**
 * AI Proxy модуль — проксирует запросы клиентов к AI провайдерам.
 *
 * Провайдеры:
 *   - tsar (ЦАРЬ РОУТЕР): OCR через Yandex/DeepSeek
 *   - gigachat (Сбер): структурирование данных
 *   - mistral-direct: Mistral OCR напрямую
 *   - routerai: Mistral OCR через RouterAI (российские карты)
 *
 * Клиент отправляет: { licenseKey, machineId, ...payload }
 * Сервер подставляет API ключ и forwarded запрос к провайдеру.
 * Сервер считает токены/расход для биллинга.
 */

const https = require('https')
const http = require('http')
const { URL } = require('url')

// ─── In-memory rate limit tracking ───
// Map<machineId, Array<timestamp>>
const rateLimitWindows = new Map()

function checkRateLimit(machineId, rpmLimit) {
  const now = Date.now()
  const windowMs = 60_000
  if (!rateLimitWindows.has(machineId)) {
    rateLimitWindows.set(machineId, [])
  }
  const timestamps = rateLimitWindows.get(machineId)
  // Clean old entries
  while (timestamps.length && now - timestamps[0] >= windowMs) {
    timestamps.shift()
  }
  if (timestamps.length >= rpmLimit) {
    const waitMs = windowMs - (now - timestamps[0]) + 1000
    return { allowed: false, retryAfter: Math.ceil(waitMs / 1000) }
  }
  timestamps.push(now)
  return { allowed: true, retryAfter: 0 }
}

// ─── HTTP request helper (server-side, no CORS issues) ───
function proxyRequest(url, method, headers, body, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const isHttps = parsed.protocol === 'https:'
    const lib = isHttps ? https : http

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method,
      headers: headers,
      timeout: timeout,
    }

    // For GigaChat — rejectUnauthorized: false (Russian SSL cert)
    if (isHttps && parsed.hostname.includes('giga.chat') || parsed.hostname.includes('sberbank.ru')) {
      options.rejectUnauthorized = false
    }

    const req = lib.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          body: data,
          headers: res.headers,
        })
      })
    })

    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Timeout'))
    })
    req.on('error', reject)

    if (body) {
      req.write(body)
    }
    req.end()
  })
}

// ─── Get active API key for a provider from DB ───
async function getProviderKey(pool, provider) {
  const result = await pool.query(
    `SELECT api_key, endpoint FROM ai_providers WHERE provider = $1 AND is_active = TRUE ORDER BY updated_at DESC LIMIT 1`,
    [provider]
  )
  if (result.rows.length === 0) return null
  return result.rows[0]
}

// ─── Get config value from DB ───
async function getConfig(pool, key) {
  const result = await pool.query(
    'SELECT value FROM app_config WHERE key = $1',
    [key]
  )
  return result.rows.length > 0 ? result.rows[0].value : null
}

// ─── Get all config as key-value map ───
async function getAllConfig(pool) {
  const result = await pool.query('SELECT key, value FROM app_config')
  const config = {}
  for (const row of result.rows) {
    config[row.key] = row.value
  }
  return config
}

// ─── Get client rate limit ───
async function getClientRateLimit(pool, machineId) {
  const result = await pool.query(
    'SELECT rate_limit_rpm FROM client_machines WHERE machine_id = $1',
    [machineId]
  )
  if (result.rows.length === 0) {
    // Default to global limit
    const globalLimit = await getConfig(pool, 'global_rate_limit_rpm')
    return parseInt(globalLimit) || 12
  }
  return result.rows[0].rate_limit_rpm
}

// ─── Register/update client machine ───
async function registerClientMachine(pool, { machineId, hostname, localIp, keyId, customer }) {
  await pool.query(`
    INSERT INTO client_machines (machine_id, hostname, local_ip, key_id, customer, last_seen)
    VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
    ON CONFLICT (machine_id)
    DO UPDATE SET
      hostname = COALESCE($2, client_machines.hostname),
      local_ip = COALESCE($3, client_machines.local_ip),
      key_id = COALESCE($4, client_machines.key_id),
      customer = COALESCE($5, client_machines.customer),
      last_seen = CURRENT_TIMESTAMP
  `, [machineId, hostname, localIp, keyId, customer])
}

// ─── Proxy: Tsar Router OCR (chat/completions) ───
async function proxyTsarOcr(pool, req, res) {
  const { machineId, body } = req.body

  if (!machineId || !body) {
    return res.status(400).json({ error: 'Не указан machineId или body' })
  }

  // Rate limit check
  const rpmLimit = await getClientRateLimit(pool, machineId)
  const rateCheck = checkRateLimit(machineId, rpmLimit)
  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: `Rate limit: ${rpmLimit} RPM. Повторите через ${rateCheck.retryAfter}с.`,
      retry_after: rateCheck.retryAfter,
    })
  }

  // Get API key
  const provider = await getProviderKey(pool, 'tsar')
  if (!provider) {
    return res.status(500).json({ error: 'API ключ ЦАРЬ РОУТЕР не настроен на сервере' })
  }

  const endpoint = await getConfig(pool, 'ocr_endpoint') || 'https://api.tsarrouter.ru/v1'

  try {
    const response = await proxyRequest(
      `${endpoint}/chat/completions`,
      'POST',
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.api_key}`,
      },
      body,
      120000
    )

    // Log usage
    await logUsage(pool, req.body, response)

    res.status(response.status).send(response.body)
  } catch (err) {
    console.error('[AI Proxy] Tsar OCR error:', err.message)
    res.status(502).json({ error: 'Ошибка проксирования OCR: ' + err.message })
  }
}

// ─── Proxy: GigaChat OAuth ───
async function proxyGigachatOAuth(pool, req, res) {
  const provider = await getProviderKey(pool, 'gigachat')
  if (!provider) {
    return res.status(500).json({ error: 'API ключ GigaChat не настроен на сервере' })
  }

  const oauthUrl = await getConfig(pool, 'gigachat_oauth_url') || 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth'
  const crypto = require('crypto')
  const rqUid = crypto.randomUUID()

  try {
    const response = await proxyRequest(
      oauthUrl,
      'POST',
      {
        'Authorization': `Basic ${provider.api_key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'RqUID': rqUid,
        'Accept': 'application/json',
      },
      'scope=GIGACHAT_API_PERS',
      30000
    )

    res.status(response.status).send(response.body)
  } catch (err) {
    console.error('[AI Proxy] GigaChat OAuth error:', err.message)
    res.status(502).json({ error: 'Ошибка OAuth: ' + err.message })
  }
}

// ─── Proxy: GigaChat chat/completions ───
async function proxyGigachatChat(pool, req, res) {
  const { machineId, body, accessToken } = req.body

  if (!body) {
    return res.status(400).json({ error: 'Не указан body' })
  }

  // Rate limit
  if (machineId) {
    const rpmLimit = await getClientRateLimit(pool, machineId)
    const rateCheck = checkRateLimit(machineId, rpmLimit)
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: `Rate limit: ${rpmLimit} RPM. Повторите через ${rateCheck.retryAfter}с.`,
        retry_after: rateCheck.retryAfter,
      })
    }
  }

  const endpoint = await getConfig(pool, 'gigachat_endpoint') || 'https://api.giga.chat/v1'

  try {
    const response = await proxyRequest(
      `${endpoint}/chat/completions`,
      'POST',
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body,
      180000
    )

    // Log usage
    await logUsage(pool, req.body, response)

    res.status(response.status).send(response.body)
  } catch (err) {
    console.error('[AI Proxy] GigaChat chat error:', err.message)
    res.status(502).json({ error: 'Ошибка проксирования GigaChat: ' + err.message })
  }
}

// ─── Proxy: Mistral OCR (direct API) ───
async function proxyMistralOcr(pool, req, res) {
  const { machineId, body } = req.body

  if (!body) {
    return res.status(400).json({ error: 'Не указан body' })
  }

  // Rate limit
  if (machineId) {
    const rpmLimit = await getClientRateLimit(pool, machineId)
    const rateCheck = checkRateLimit(machineId, rpmLimit)
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: `Rate limit: ${rpmLimit} RPM. Повторите через ${rateCheck.retryAfter}с.`,
        retry_after: rateCheck.retryAfter,
      })
    }
  }

  const provider = await getProviderKey(pool, 'mistral-direct')
  if (!provider) {
    return res.status(500).json({ error: 'API ключ Mistral не настроен на сервере' })
  }

  const endpoint = await getConfig(pool, 'mistral_endpoint') || 'https://api.mistral.ai/v1'

  try {
    const response = await proxyRequest(
      `${endpoint}/ocr`,
      'POST',
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.api_key}`,
      },
      body,
      300000
    )

    await logUsage(pool, req.body, response)
    res.status(response.status).send(response.body)
  } catch (err) {
    console.error('[AI Proxy] Mistral OCR error:', err.message)
    res.status(502).json({ error: 'Ошибка проксирования Mistral: ' + err.message })
  }
}

// ─── Proxy: Mistral file upload (direct API) ───
async function proxyMistralUpload(pool, req, res) {
  const { machineId, fileBase64, filename, mimeType, purpose } = req.body

  if (!fileBase64) {
    return res.status(400).json({ error: 'Не указан fileBase64' })
  }

  const provider = await getProviderKey(pool, 'mistral-direct')
  if (!provider) {
    return res.status(500).json({ error: 'API ключ Mistral не настроен на сервере' })
  }

  const endpoint = await getConfig(pool, 'mistral_endpoint') || 'https://api.mistral.ai/v1'

  // Build multipart/form-data
  const boundary = '----FormBoundary' + Math.random().toString(36).substring(2)
  const fileBuffer = Buffer.from(fileBase64, 'base64')

  const parts = []
  // purpose field
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n${purpose || 'ocr'}\r\n`)
  // file field
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename || 'document.pdf'}"\r\nContent-Type: ${mimeType || 'application/pdf'}\r\n\r\n`)
  const endBoundary = `\r\n--${boundary}--\r\n`

  const bodyBuffer = Buffer.concat([
    Buffer.from(parts.join(''), 'utf8'),
    fileBuffer,
    Buffer.from(endBoundary, 'utf8'),
  ])

  try {
    const response = await proxyRequest(
      `${endpoint}/files`,
      'POST',
      {
        'Authorization': `Bearer ${provider.api_key}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      bodyBuffer,
      120000
    )

    res.status(response.status).send(response.body)
  } catch (err) {
    console.error('[AI Proxy] Mistral upload error:', err.message)
    res.status(502).json({ error: 'Ошибка загрузки файла: ' + err.message })
  }
}

// ─── Proxy: Mistral file delete (direct API) ───
async function proxyMistralDelete(pool, req, res) {
  const { fileId } = req.body
  if (!fileId) return res.status(400).json({ error: 'Не указан fileId' })

  const provider = await getProviderKey(pool, 'mistral-direct')
  if (!provider) return res.status(500).json({ error: 'API ключ Mistral не настроен' })

  const endpoint = await getConfig(pool, 'mistral_endpoint') || 'https://api.mistral.ai/v1'

  try {
    const response = await proxyRequest(
      `${endpoint}/files/delete`,
      'POST',
      {
        'Authorization': `Bearer ${provider.api_key}`,
        'Content-Type': 'application/json',
      },
      JSON.stringify({ file_id: fileId }),
      10000
    )
    res.status(response.status).send(response.body)
  } catch (err) {
    res.status(502).json({ error: 'Ошибка удаления файла: ' + err.message })
  }
}

// ─── Proxy: RouterAI (Mistral via RouterAI) ───
async function proxyRouterAi(pool, req, res) {
  const { machineId, body } = req.body

  if (!body) {
    return res.status(400).json({ error: 'Не указан body' })
  }

  if (machineId) {
    const rpmLimit = await getClientRateLimit(pool, machineId)
    const rateCheck = checkRateLimit(machineId, rpmLimit)
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: `Rate limit: ${rpmLimit} RPM. Повторите через ${rateCheck.retryAfter}с.`,
        retry_after: rateCheck.retryAfter,
      })
    }
  }

  const provider = await getProviderKey(pool, 'routerai')
  if (!provider) {
    return res.status(500).json({ error: 'API ключ RouterAI не настроен на сервере' })
  }

  const endpoint = await getConfig(pool, 'routerai_endpoint') || 'https://routerai.ru/api/v1'

  try {
    const response = await proxyRequest(
      `${endpoint}/chat/completions`,
      'POST',
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.api_key}`,
      },
      body,
      300000
    )

    await logUsage(pool, req.body, response)
    res.status(response.status).send(response.body)
  } catch (err) {
    console.error('[AI Proxy] RouterAI error:', err.message)
    res.status(502).json({ error: 'Ошибка проксирования RouterAI: ' + err.message })
  }
}

// ─── Log token usage ───
async function logUsage(pool, reqBody, response) {
  try {
    const { keyId, customer, machineId, documentType } = reqBody
    if (!keyId) return

    // Try to extract token count from response
    let tokensUsed = 0
    if (response && response.body) {
      try {
        const json = JSON.parse(response.body)
        tokensUsed = (json.usage?.total_tokens) || (json.usage?.prompt_tokens + json.usage?.completion_tokens) || 0
      } catch {}
    }

    if (tokensUsed === 0) return

    // Calculate cost
    const type = documentType || 'standard'
    const costPer1k = parseFloat(process.env.COST_PER_1K_TOKENS_STANDARD || '0.50')
    const cost = Math.round((tokensUsed / 1000) * costPer1k * 100) / 100

    // Find license
    const licResult = await pool.query('SELECT id FROM licenses WHERE key_id = $1', [keyId])
    const licenseId = licResult.rows.length > 0 ? licResult.rows[0].id : null

    await pool.query(`
      INSERT INTO token_usage (license_id, key_id, customer, machine_id, tokens_used, cost_rubles, document_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [licenseId, keyId, customer || 'Unknown', machineId, tokensUsed, cost, type])
  } catch (err) {
    console.warn('[AI Proxy] Usage log error:', err.message)
  }
}

module.exports = {
  proxyTsarOcr,
  proxyGigachatOAuth,
  proxyGigachatChat,
  proxyMistralOcr,
  proxyMistralUpload,
  proxyMistralDelete,
  proxyRouterAi,
  registerClientMachine,
  getClientRateLimit,
  getConfig,
  getAllConfig,
  checkRateLimit,
}
