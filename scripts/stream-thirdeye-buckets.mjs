#!/usr/bin/env node
/**
 * Create the per-bucket Sablier LockupLinear streams for THIRDEYE.
 *
 * Run AFTER scripts/deploy-thirdeye.mjs has deployed the token and after the 38% vault tranche has been
 * claimed to the treasury (day 30). The ops float (2%) is not streamed: Clanker delivers it at deploy
 * with zero lockup.
 *
 *   node scripts/stream-thirdeye-buckets.mjs --dry-run   # print schedule, simulate, no transactions
 *   node scripts/stream-thirdeye-buckets.mjs --confirm   # create the streams
 *
 * Requires:
 *   THIRDEYE_TOKEN_ADDRESS   deployed token
 *   SABLIER_LOCKUP_LINEAR    verified Sablier LockupLinear address on Base (no default: the address must
 *                            be checked against Sablier's own deployment list and confirmed to have code)
 */
import { readFileSync } from 'node:fs'

const TREASURY = '0x73faf95b2baa23bde4ce8547b64c55159022cf0d'
const DECIMALS = 18n
const TOTAL_SUPPLY = 100_000_000_000n
const MONTH = 2_592_000

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const confirmed = args.includes('--confirm')
if (!dryRun && !confirmed) {
  console.error('Refusing to run: pass --dry-run to validate or --confirm to create streams.')
  process.exit(1)
}

/** cliffMonths / linearMonths come straight from docs/tokenomics.md */
const BUCKETS = [
  { key: 'dev', label: 'Dev & operations', pct: 12, cliffMonths: 6, linearMonths: 24 },
  { key: 'community', label: 'Community rewards', pct: 10, cliffMonths: 1, linearMonths: 6 },
  { key: 'partners', label: 'Partner incentives', pct: 6, cliffMonths: 1, linearMonths: 0 },
  { key: 'promo', label: 'Promo: limit-price package buyers', pct: 4, cliffMonths: 1, linearMonths: 0 },
  { key: 'platform-airdrops', label: 'Platform airdrops (Abund.ai+)', pct: 3, cliffMonths: 1, linearMonths: 0 },
  { key: 'early-members', label: 'Early member airdrop', pct: 3, cliffMonths: 1, linearMonths: 12 },
]

const amountFor = (pct) => (TOTAL_SUPPLY * BigInt(pct)) / 100n
const vaultPct = BUCKETS.reduce((a, b) => a + b.pct, 0)
if (vaultPct !== 38) throw new Error(`bucket percentages must total the 38% vault tranche, got ${vaultPct}`)

console.log('--- THIRDEYE bucket streams ---')
console.log(`vault tranche: ${vaultPct}% = ${amountFor(vaultPct)} THIRDEYE (unstreamed ops float: 2%)\n`)
for (const b of BUCKETS) {
  const cliff = b.cliffMonths * MONTH
  const total = (b.cliffMonths + b.linearMonths) * MONTH
  const months = b.linearMonths === 0 ? 'all at cliff' : `${b.linearMonths}mo linear`
  console.log(
    `${b.label.padEnd(34)} ${String(b.pct).padStart(2)}%  ${String(amountFor(b.pct)).padStart(12)}  cliff ${b.cliffMonths}mo  ${months}  (total ${total}s)`
  )
}

const token = process.env.THIRDEYE_TOKEN_ADDRESS || ''
const sablier = process.env.SABLIER_LOCKUP_LINEAR || ''

const { createPublicClient, http, parseAbi, encodeFunctionData, formatUnits } = await import('viem')
const { base } = await import('viem/chains')
const publicClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || 'https://mainnet.base.org') })

if (!token || !sablier) {
  console.log('\nMissing THIRDEYE_TOKEN_ADDRESS or SABLIER_LOCKUP_LINEAR. Schedule validated; nothing built.')
  process.exit(0)
}

const code = await publicClient.getCode({ address: sablier })
if (!code || code === '0x') {
  console.error(`\nNo bytecode at ${sablier} on Base. Refusing to build streams against a non-contract.`)
  process.exit(1)
}
console.log(`\nSablier LockupLinear has code on Base (${(code.length - 2) / 2} bytes)`)

const lockupLinearAbi = parseAbi([
  'struct Amounts { uint128 deposit; uint128 brokerFee; }',
  'struct Durations { uint40 cliff; uint40 total; }',
  'struct CreateWithDurations { address sender; address recipient; uint128 totalAmount; address asset; bool cancelable; bool transferable; Durations durations; bool brokerFeeEnabled; Amounts amounts; }',
  'function createWithDurations(CreateWithDurations params) returns (uint256 streamId)',
])

const streams = BUCKETS.map((b) => ({
  label: b.label,
  params: {
    sender: TREASURY,
    recipient: TREASURY,
    totalAmount: amountFor(b.pct) * 10n ** DECIMALS,
    asset: token,
    cancelable: false,
    transferable: true,
    durations: { cliff: BigInt(b.cliffMonths * MONTH), total: BigInt((b.cliffMonths + b.linearMonths) * MONTH) },
    brokerFeeEnabled: false,
    amounts: { deposit: 0n, brokerFee: 0n },
  },
}))

for (const s of streams) {
  try {
    await publicClient.simulateContract({
      address: sablier,
      abi: lockupLinearAbi,
      functionName: 'createWithDurations',
      args: [s.params],
      account: TREASURY,
    })
    console.log(`  ok   ${s.label}`)
  } catch (e) {
    console.log(`  FAIL ${s.label}: ${String(e.shortMessage || e.message).split('\n')[0]}`)
  }
}

if (dryRun) {
  console.log('\nDry run only. The simulation above runs from the treasury address; a real creation needs the')
  console.log('treasury signer (Sam passkey) plus token approval to Sablier.')
  process.exit(0)
}
console.log('\nSending requires the treasury signer and a setApprovalForAll/approve to Sablier. Not implemented')
console.log('for an agent key: the treasury is passkey-only, so stream creation is a treasury-signed action.')
