#!/usr/bin/env node
/**
 * Rehearsal v2: let the real SDK build the deploy transaction, then simulate it
 * against live Base state with a funded state override. Nothing is signed or sent.
 *
 * The SDK (clanker-sdk/v4) exposes Clanker#getDeployTransaction, so the calldata,
 * salt scheme and extension calls come from the SDK itself rather than from a guess.
 */
const RPC = process.env.BASE_RPC || 'https://base-rpc.publicnode.com'
const DEPLOYER = (process.env.REHEARSAL_DEPLOYER || '0x3F3C5af93542B42E5f457CB3711Bc551f2898dEF').toLowerCase()
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const IMAGE = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

const { createPublicClient, http, toHex, encodeFunctionData } = await import('viem')
const { base } = await import('viem/chains')
const { Clanker } = await import('clanker-sdk/v4')
const { FEE_CONFIGS, POOL_POSITIONS, getTickFromMarketCapUSDC } = await import('clanker-sdk')
const { createAirdrop } = await import('clanker-sdk/v4/extensions')

const publicClient = createPublicClient({ chain: base, transport: http(RPC) })

// A wallet that can never send: if the SDK tries to broadcast, we learn immediately.
const wallet = {
  account: { address: DEPLOYER, type: 'json-rpc' },
  chain: base,
  writeContract: async () => { throw new Error('BLOCKED: writeContract would have broadcast') },
  sendTransaction: async () => { throw new Error('BLOCKED: sendTransaction would have broadcast') },
}

const clanker = new Clanker({ wallet, publicClient })

const TREASURY = '0x73fAf95B2Baa23bde4CE8547b64C55159022Cf0d'
const USDC_TICK = getTickFromMarketCapUSDC(100_000) // USD-denominated helper: target ~$100k FDV
// 2% ops float, delivered at deploy with no lockup, to the treasury for now.
const { airdrop } = createAirdrop([
  // Clanker floors an airdrop amount at 250,000,000 raw units, which for an
  // 18-decimal token is 250M / 1e18 of a token. Its docs example passes raw token
  // units, so this is the smallest airdrop the extension will accept here.
  { account: TREASURY, amount: 250_000_000 },
])

const config = {
  name: 'Thirdeye',
  symbol: 'THIRDEYE',
  image: IMAGE,
  tokenAdmin: DEPLOYER,
  chainId: 8453,
  metadata: { description: 'Crypto-native AI gateway. Per-call USDC pricing.' },
  context: { interface: 'Thirdeye rehearsal' },
  // USDC pairing needs the USDC-specific tick helper, and one position must touch
  // the starting tick, so the range is built from that tick rather than a preset.
  pool: {
    pairedToken: USDC_BASE,
    tickIfToken0IsClanker: USDC_TICK,
    tickSpacing: 200,
    positions: [{ tickLower: USDC_TICK, tickUpper: -120000, positionBps: 10_000 }],
  },
  fees: FEE_CONFIGS.StaticBasic,
  // Vault: the 38% treasury allocation, 30 day cliff, no linear tail, as agreed.
  vault: {
    percentage: 38,
    lockupDuration: 2_592_000,
    vestingDuration: 0,
    recipient: TREASURY,
  },
  // Singular `airdrop` key. Clanker enforces lockupDuration >= 86400 (1 day), so a
  // true zero-lockup ops float is not expressible here; 1 day is the floor.
  airdrop: { ...airdrop, lockupDuration: 86_400, vestingDuration: 0 },
}

let tx
try {
  tx = await clanker.getDeployTransaction(config)
} catch (e) {
  console.log('SDK could not build the deploy transaction:', String(e.message).slice(0, 220))
  process.exit(1)
}

const to = tx.to ?? tx.address
// The SDK returns a viem contract request (abi + functionName + args); encode it.
const data = tx.data ?? tx.calldata ?? (tx.abi && tx.functionName
  ? encodeFunctionData({ abi: tx.abi, functionName: tx.functionName, args: tx.args })
  : undefined)
console.log('built by the SDK, not by hand')
console.log('  to      ', to)
console.log('  value   ', tx.value ?? 0n)
console.log('  calldata', String(data).length, 'chars')
if (tx.type === 'calls' || Array.isArray(tx.calls)) console.log('  bundled calls:', tx.calls.length)
if (tx.abi && tx.functionName) console.log('  function', tx.functionName, '| args', String(JSON.stringify(tx.args, (k, v) => typeof v === 'bigint' ? v.toString() : v)).slice(0, 220))

// Simulate against live Base state with the deployer funded.
const overrides = { [DEPLOYER]: { balance: toHex(10n ** 18n) } }
try {
  const out = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from: DEPLOYER, to, data, gas: toHex(9_000_000n) }, 'latest', overrides] }),
    signal: AbortSignal.timeout(25000),
  }).then((r) => r.json())
  if (out.error) throw new Error(out.error.message)
  console.log('\nSIMULATION: would SUCCEED against live Base state. returned', String(out.result).slice(0, 66))
} catch (e) {
  console.log('\nSIMULATION: would revert ->', String(e.message).slice(0, 240))
  process.exitCode = 2
}
