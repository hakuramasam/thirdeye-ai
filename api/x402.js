import 'dotenv/config'
import express from 'express'
import { facilitator } from '@payai/facilitator'
import { HTTPFacilitatorClient } from '@x402/core/server'
import { paymentMiddleware, x402ResourceServer } from '@x402/express'
import { ExactEvmScheme } from '@x402/evm/exact/server'

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '16kb' }))

const NETWORK = 'eip155:8453'
const enabled = process.env.X402_ENABLED === 'true'
const payTo = (process.env.X402_PAY_TO || '').trim()
const price = (process.env.X402_PRICE_USD || '').trim()
const walletIsValid = /^0x[0-9a-fA-F]{40}$/.test(payTo)
const priceIsValid = /^\$(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(price) && Number(price.slice(1)) > 0

app.get('/api/x402/status', (_req, res) => {
  res.json({
    protocol: 'x402',
    facilitator: 'PayAI',
    network: NETWORK,
    enabled: enabled && walletIsValid && priceIsValid,
    configuration: {
      enabledFlag: enabled,
      receivingWalletConfigured: walletIsValid,
      priceConfigured: priceIsValid,
    },
    note: 'Mainnet settlement is opt-in. No payment route is activated until all required X402_* settings are valid.',
  })
})

if (enabled && walletIsValid && priceIsValid) {
  const facilitatorClient = new HTTPFacilitatorClient(facilitator)
  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(NETWORK, new ExactEvmScheme())

  app.use(paymentMiddleware(
    {
      'GET /api/x402/premium': {
        accepts: [{
          scheme: 'exact',
          price,
          network: NETWORK,
          payTo,
        }],
        description: 'ThirdEye AI premium API demonstration endpoint',
        mimeType: 'application/json',
      },
    },
    resourceServer,
  ))

  app.get('/api/x402/premium', (_req, res) => {
    res.json({
      service: 'ThirdEye AI',
      product: 'premium-api-demo',
      message: 'Payment verified by the PayAI x402 facilitator.',
      network: NETWORK,
    })
  })
} else {
  app.get('/api/x402/premium', (_req, res) => {
    res.status(503).json({
      error: 'x402 mainnet route is not enabled',
      required: ['X402_ENABLED=true', 'X402_PAY_TO=0x…', 'X402_PRICE_USD=$0.01'],
    })
  })
}

app.use((err, _req, res, _next) => {
  console.error('[thirdeye:x402] request failed:', err?.message || 'unknown error')
  res.status(500).json({ error: 'x402 gateway error' })
})

export default app
