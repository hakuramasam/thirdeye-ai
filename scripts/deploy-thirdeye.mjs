#!/usr/bin/env node
/**
 * Deploy the THIRDEYE token on Base through Clanker v4.
 *
 *   node scripts/deploy-thirdeye.mjs --dry-run    # validate config + estimate gas, no transaction
 *   node scripts/deploy-thirdeye.mjs --confirm    # actually deploy
 *
 * Allocation is fixed by docs/tokenomics.md:
 *   pool 60% | vault 38% (Split, 6mo cliff + 24mo linear) | airdrop 2% to treasury, no lockup
 */
import { readFileSync } from 'node:fs'

const TREASURY = '0x73faf95b2baa23bde4ce8547b64c55159022cf0d' // Splits V1 vault, passkey-signed
const WETH_BASE = '0x4200000000000000000000000000000000000006'
const TOTAL_SUPPLY = 100_000_000_000n
const SIX_MONTHS = 15_552_000
const TWENTY_FOUR_MONTHS = 63_072_000
const INITIAL_MARKET_CAP_ETH = 15

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const confirmed = args.includes('--confirm')
if (!dryRun && !confirmed) {
  console.error('Refusing to run: pass --dry-run to validate or --confirm to deploy for real.')
  process.exit(1)
}

const splitRecipient = process.env.THIRDEYE_SPLIT_ADDRESS || ''
if (!splitRecipient && confirmed) {
  console.error('THIRDEYE_SPLIT_ADDRESS is required: the 38% vault tranche must land in the allocation Split.')
  process.exit(1)
}

const vaultRecipient = splitRecipient || TREASURY
const opsFloat = (TOTAL_SUPPLY * 2n) / 100n

const { Clanker } = await import('clanker-sdk')
const { createAirdrop } = await import('clanker-sdk/v4/extensions')
const { createPublicClient, createWalletClient, http } = await import('viem')
const { privateKeyToAccount } = await import('viem/accounts')
const { base } = await import('viem/chains')
const { getTickFromMarketCap } = await import('clanker-sdk')

const { tree, airdrop } = createAirdrop([{ account: TREASURY, amount: Number(opsFloat) }])

const tick = getTickFromMarketCap(INITIAL_MARKET_CAP_ETH)

const config = {
  name: 'Thirdeye',
  symbol: 'THIRDEYE',
  tokenAdmin: TREASURY,
  chainId: base.id,
  metadata: {
    description:
      'Settlement token for Thirdeye: pay for AI model inference in THIRDEYE, on Base.',
    socialMediaUrls: [{ platform: 'twitter', url: 'https://x.com/Thirdeye_AI' }],
  },
  context: { interface: 'Thirdeye platform' },
  pool: {
    pairedToken: WETH_BASE,
    positions: 'Standard',
    tickIfToken0IsClanker: tick.tickIfToken0IsClanker,
    tickSpacing: tick.tickSpacing,
  },
  rewards: {
    recipients: [
      { recipient: TREASURY, admin: TREASURY, bps: 10_000, token: 'Paired' },
    ],
  },
  vault: {
    percentage: 38,
    lockupDuration: SIX_MONTHS,
    vestingDuration: TWENTY_FOUR_MONTHS,
    recipient: vaultRecipient,
  },
  airdrop: { ...airdrop, lockupDuration: 0, vestingDuration: 0 },
  sniperFees: { startingFee: 666_777, endingFee: 41_673, secondsToDecay: 15 },
  vanity: false,
}

console.log('--- THIRDEYE deploy plan ---')
console.log(JSON.stringify({
  supply: TOTAL_SUPPLY.toString(),
  pool_pct: 60,
  vault_pct: 38,
  vault_recipient: vaultRecipient,
  vault_unlock: '6mo cliff + 24mo linear',
  airdrop_pct: 2,
  airdrop_recipient: TREASURY,
  airdrop_amount: opsFloat.toString(),
  initial_market_cap_eth: INITIAL_MARKET_CAP_ETH,
  fees: '100% -> treasury, paired token (WETH)',
  merkle_root: tree.dump().merkleRoot,
}, null, 2))

function loadKey() {
  const inline = process.env.AGENT_WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY
  if (inline) return inline
  for (const p of ['.env.production.local', '.env.local', '.env']) {
    try {
      const m = /^(?:AGENT_WALLET_PRIVATE_KEY|PRIVATE_KEY)=(.+)$/m.exec(readFileSync(p, 'utf8'))
      if (m) return m[1].trim().replace(/^["']|["']$/g, '')
    } catch {}
  }
  return ''
}

const pk = loadKey()
const rpc = process.env.BASE_RPC_URL || 'https://mainnet.base.org'
const publicClient = createPublicClient({ chain: base, transport: http(rpc) })

if (!pk) {
  console.log('\nNo signer key available (AGENT_WALLET_PRIVATE_KEY). Config validated, nothing signed.')
  process.exit(0)
}

const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`)
const balance = await publicClient.getBalance({ address: account.address })
const gasPrice = await publicClient.getGasPrice()
console.log(`\nsigner: ${account.address}`)
console.log(`balance: ${Number(balance) / 1e18} ETH`)
console.log(`gas price: ${Number(gasPrice) / 1e9} gwei`)

if (dryRun) {
  const roughGas = 6_000_000n
  const est = (roughGas * gasPrice * 12n) / 10n
  console.log(`estimated deploy cost (6M gas + 20% headroom, excl. L1 data fee): ~${Number(est) / 1e18} ETH`)
  console.log(`sufficient balance: ${balance >= est ? 'yes' : 'NO - top up needed'}`)
  process.exit(0)
}

const wallet = createWalletClient({ account, chain: base, transport: http(rpc) })
const clanker = new Clanker({ wallet, publicClient })
const { txHash, waitForTransaction, error } = await clanker.deploy(config)
if (error) {
  console.error('deploy failed:', error)
  process.exit(1)
}
console.log(`deploying: ${base.blockExplorers.default.url}/tx/${txHash}`)
const { address } = await waitForTransaction()
console.log(`THIRDEYE deployed at ${address}`)
console.log(`set PLATFORM_TOKEN_ADDRESS=${address} then redeploy the site.`)
