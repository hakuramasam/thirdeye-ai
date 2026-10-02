import type { SessionApp } from '../lib/session.js'
import { env, sha256 } from '../lib/env.js'
import { query } from '../db/index.js'

/**
 * Thirdeye AI Telegram community bot.
 * Telegram sends POSTs to /api/telegram/webhook (set via setWebhook with
 * secret_token = sha256(bot token)). Features: welcome for new members,
 * live FAQ (/models /pricing /deposit /key /help /support), and a simple
 * anti-spam rule: links from members who joined < 24h ago are removed.
 */

const API = () => `https://api.telegram.org/bot${env.telegramBotToken}`
const SITE = 'https://thirdeye-ai-alpha.vercel.app'
const JOIN_GRACE_HOURS = 24

async function tg(method: string, payload: Record<string, unknown>): Promise<void> {
  if (!env.telegramBotToken) return
  await fetch(`${API()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {})
}

const HELP = [
  'Thirdeye AI community bot — commands:',
  '/models — live models + per-1M-token prices',
  '/deposit — how to top up with USDC (Base) or USDG (Robinhood Chain)',
  '/key — get your sk-thirdeye- API key',
  '/support — reach the team',
  '',
  `Website: ${SITE}`,
].join('\n')

export function registerTelegramRoutes(app: SessionApp) {
  app.post('/api/telegram/webhook', async (c) => {
    if (!env.telegramBotToken) return c.json({ ok: true }) // inert until token configured
    if (c.req.header('x-telegram-bot-api-secret-token') !== sha256(env.telegramBotToken)) {
      return c.json({ error: { message: 'Forbidden', type: 'auth', code: 403 } }, 403)
    }
    const update: any = await c.req.json().catch(() => null)
    if (!update) return c.json({ ok: true })

    const msg = update.message
    if (!msg?.chat?.id) return c.json({ ok: true })
    const chatId = msg.chat.id
    const text: string = typeof msg.text === 'string' ? msg.text.trim() : ''
    const from = msg.from ?? {}
    const isAdmin = env.telegramAdminIds.includes(String(from.id))

    // New members: remember join time + welcome
    if (Array.isArray(msg.new_chat_members) && msg.new_chat_members.length > 0) {
      for (const m of msg.new_chat_members) {
        if (!m?.id) continue
        if (m.is_bot && String(m.id) !== String(from.id)) continue // other bots: stay quiet
        await query(
          `INSERT INTO telegram_members (chat_id, user_id, username, joined_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (chat_id, user_id) DO NOTHING`,
          [chatId, m.id, m.username ?? '']
        )
        if (!m.is_bot) {
          await tg('sendMessage', {
            chat_id: chatId,
            text: `Welcome, ${m.username ? '@' + m.username : m.first_name ?? 'friend'}! You're in the Thirdeye AI community — the crypto-native LLM gateway. Type /help to get started.`,
          })
        }
      }
      return c.json({ ok: true })
    }

    // Commands
    if (text.startsWith('/')) {
      const cmd = text.split(/[\s@]/)[0].toLowerCase()
      if (cmd === '/help' || cmd === '/start') {
        await tg('sendMessage', { chat_id: chatId, text: HELP })
      } else if (cmd === '/models' || cmd === '/pricing') {
        const rows: any[] = (await query('SELECT model, price_in_1m_usd_micros, price_out_1m_usd_micros FROM models_catalog ORDER BY price_in_1m_usd_micros ASC')).rows ?? []
        const lines = ['Live models (USD per 1M tokens, in → out):', ...rows.map(
          (r) => `• ${r.model} — $${(Number(r.price_in_1m_usd_micros) / 1e6).toFixed(2)} / $${(Number(r.price_out_1m_usd_micros) / 1e6).toFixed(2)}`
        ), '', `Sign in and call any of them: ${SITE}`]
        await tg('sendMessage', { chat_id: chatId, text: lines.join('\n') })
      } else if (cmd === '/deposit') {
        const recv = env.platformReceiverAddress || '(not configured yet)'
        await tg('sendMessage', {
          chat_id: chatId,
          text: [
            'How to top up:',
            `1. Sign in at ${SITE} with your wallet.`,
            `2. Send USDC (on Base) or USDG (on Robinhood Chain) from that same wallet to: ${recv}`,
            '3. Paste the transaction hash into the deposit form on your dashboard.',
            'Credits appear once the transfer is verified on-chain.',
            '',
            'No credit card, no subscription — pay per token.',
          ].join('\n'),
        })
      } else if (cmd === '/key') {
        await tg('sendMessage', {
          chat_id: chatId,
          text: [
            'Getting an API key:',
            `1. Sign in at ${SITE} with your wallet.`,
            '2. Open the Keys tab → Create key.',
            '3. Use it with any OpenAI-compatible client:',
            `   base URL: ${SITE}/api/v1`,
            '   Authorization: Bearer sk-thirdeye-...',
          ].join('\n'),
        })
      } else if (cmd === '/support') {
        await tg('sendMessage', {
          chat_id: chatId,
          text: 'Someone from the team will reply here shortly. For account or billing issues, include your wallet address (never your API key).',
        })
      }
      return c.json({ ok: true })
    }

    // Anti-spam: links from members who joined less than 24h ago
    if (!isAdmin && /\bhttps?:\/\/|t\.me\//i.test(text)) {
      const r: any = await query(
        'SELECT EXTRACT(EPOCH FROM (NOW() - joined_at)) / 3600 AS hours FROM telegram_members WHERE chat_id = $1 AND user_id = $2',
        [chatId, from.id]
      )
      const hours = Number(r.rows?.[0]?.hours)
      if (Number.isFinite(hours) && hours < JOIN_GRACE_HOURS) {
        await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id })
        await tg('sendMessage', {
          chat_id: chatId,
          text: 'Links from brand-new members are removed to keep spam out — stick around a bit, then share away. Questions? /help',
        })
      }
    }

    return c.json({ ok: true })
  })

  // No info leak on GET
  app.get('/api/telegram/webhook', (c) => c.json({ error: { message: 'Not found', type: 'invalid', code: 404 } }, 404))
}
