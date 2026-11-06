#!/usr/bin/env node
/**
 * Post-deploy sweep: move the claimed token airdrop from the hot deployer wallet
 * into the passkey-controlled treasury vault.
 *
 * Runs dry by default: it prints the plan and simulates, and only sends with --confirm.
 *
 * Usage:
 *   THIRDEYE_TOKEN_ADDRESS=0x... node scripts/sweep-airdrop-to-treasury.mjs
 *   THIRDEYE_TOKEN_ADDRESS=0x... node scripts/sweep-airdrop-to-treasury.mjs --confirm
 *
 * Env:
 *   THIRDEYE_TOKEN_ADDRESS  deployed token (required)
 *   DEPLOYER_PRIVATE_KEY    the deployer/hot key that received the airdrop (required to send)
 *   TREASURY_ADDRESS        destination, defaults to the Splits treasury vault
 *   SWEEP_RESERVE_TOKENS    optional tokens to leave behind, in whole tokens
 *   BASE_RPC                optional RPC override
 */
import { planSweep, sweepAmount } from '../src/lib/sweepGuard.js'

const RPC = process.env.BASE_RPC || 'https://base-rpc.publicnode.com'
const TOKEN = process.env.THIRDEYE_TOKEN_ADDRESS || ''
const TREASURY = process.env.TREASURY_ADDRESS || '0x73fAf95B2Baa23bde4CE8547b64C55159022Cf0d'
const KEY = process.env.DEPLOYER_PRIVATE_KEY || ''
const confirm = process.argv.includes('--confirm')

const { createPublicClient, createWalletClient, http, parseAbi, formatUnits } = await import('viem')
const { privateKeyToAccount } = await import('viem/accounts')
const { base } = await import('viem/chains')

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)',
])

const publicClient = createPublicClient({ chain: base, transport: http(RPC) })
const chainId = await publicClient.getChainId()
if (chainId !== 8453) {
  console.log(`Refusing to run on chain ${chainId}; this sweep is Base 8453 only.`)
  process.exit(1)
}

const account = KEY ? privateKeyToAccount(KEY.startsWith('0x') ? KEY : `0x${KEY}`) : null
const deployer = account?.address ?? (process.env.DEPLOYER_ADDRESS || '')
if (!deployer) {
  console.log('No deployer: set DEPLOYER_PRIVATE_KEY (to send) or DEPLOYER_ADDRESS (to inspect).')
  process.exit(1)
}

const [balanceWei, gasWei, decimals, symbol] = await Promise.all([
  TOKEN ? publicClient.readContract({ address: TOKEN, abi: erc20, functionName: 'balanceOf', args: [deployer] }).catch(() => 0n) : 0n,
  publicClient.getBalance({ address: deployer }),
  TOKEN ? publicClient.readContract({ address: TOKEN, abi: erc20, functionName: 'decimals' }).catch(() => 18) : 18,
  TOKEN ? publicClient.readContract({ address: TOKEN, abi: erc20, functionName: 'symbol' }).catch(() => '?') : '?',
])
const gasBalanceEth = Number(gasWei) / 1e18
const reserve = BigInt(Math.max(0, Math.floor(Number(process.env.SWEEP_RESERVE_TOKENS || '0')))) * 10n ** BigInt(decimals)

console.log('post-deploy sweep plan')
console.log('  token    ', TOKEN || '(unset)', symbol)
console.log('  deployer ', deployer, `${formatUnits(balanceWei, decimals)} ${symbol}`, `| gas ${gasBalanceEth} ETH`)
console.log('  treasury ', TREASURY)

const plan = planSweep({
  tokenAddress: TOKEN,
  deployer,
  treasury: TREASURY,
  balanceWei,
  gasBalanceEth,
  reserveFloorWei: reserve,
})
for (const w of plan.warnings) console.log('  warn ', w)

if (!plan.ok) {
  for (const r of plan.reasons) console.log('  stop ', r)
  console.log('\nNothing sent.')
  process.exit(1)
}

const amount = sweepAmount(balanceWei, reserve)
console.log(`  amount   ${formatUnits(amount, decimals)} ${symbol} -> treasury`)

if (!account) {
  console.log('\nInspect only: no DEPLOYER_PRIVATE_KEY, so nothing can be signed.')
  process.exit(0)
}

// Simulate before sending: a sweep that would revert should never be broadcast.
try {
  await publicClient.simulateContract({
    account, address: TOKEN, abi: erc20, functionName: 'transfer', args: [TREASURY, amount],
  })
  console.log('  simulate ok')
} catch (e) {
  console.log('  simulate FAILED:', String(e.shortMessage ?? e.message).slice(0, 200))
  console.log('\nNothing sent.')
  process.exit(2)
}

if (!confirm) {
  console.log('\nDry run complete. Re-run with --confirm to send.')
  process.exit(0)
}

const wallet = createWalletClient({ account, chain: base, transport: http(RPC) })
const hash = await wallet.writeContract({ address: TOKEN, abi: erc20, functionName: 'transfer', args: [TREASURY, amount] })
console.log('  sent     ', hash)
const receipt = await publicClient.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success') {
  console.log('  receipt  REVERTED')
  process.exit(3)
}
const after = await publicClient.readContract({ address: TOKEN, abi: erc20, functionName: 'balanceOf', args: [TREASURY] })
console.log(`  done     treasury now holds ${formatUnits(after, decimals)} ${symbol}`)
