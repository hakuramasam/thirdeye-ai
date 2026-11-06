#!/usr/bin/env node
/**
 * Fork-less rehearsal of the real Clanker deploy call against live Base state.
 *
 * Runs the exact factory call the SDK would send, as eth_call with a state
 * override that funds the deployer, against Base mainnet state. Nothing is
 * signed, nothing is broadcast, nothing is spent. It answers one question:
 * would this deploy succeed against the real contract, and what address would
 * the token get.
 *
 * What this does NOT cover: Clanker v4 may bundle pool/vault/airdrop calls with
 * the deploy. This rehearses the factory's deployToken step; the bundled
 * extension steps still need a fork or a mainnet rehearsal.
 *
 * Usage: node scripts/rehearse-clanker-sim.mjs
 */
const RPC = process.env.BASE_RPC || 'https://base-rpc.publicnode.com'
const FACTORY = '0x250c9FB2b411B48273f69879007803790A6AeA47'
const DEPLOYER = (process.env.REHEARSAL_DEPLOYER || '0x3F3C5af93542B42E5f457CB3711Bc551f2898dEF').toLowerCase()
const NAME = 'Thirdeye'
const SYMBOL = 'THIRDEYE'
const SUPPLY = 1_000_000_000n * 10n ** 18n

const { encodeFunctionData, keccak256, toHex, parseAbi } = await import('viem')
const { getTickFromMarketCap, FEE_CONFIGS } = await import('clanker-sdk')

const abi = parseAbi([
  'function deployToken(string name, string symbol, uint256 supply, int24 tickIfToken0IsClanker, uint24 lpFee, bytes32 salt, address msgSender) returns (address)',
  'function predictToken(address deployer, string name, string symbol, uint256 supply, bytes32 salt) view returns (address)',
  'function generateSalt(address msgSender, string name, string symbol, uint256 supply) view returns (bytes32)',
])

const call = async (method, params) => {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20000),
  })
  const j = await res.json()
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}

const code = await call('eth_getCode', [FACTORY, 'latest'])
console.log('Clanker factory', FACTORY, code && code !== '0x' ? 'is live on Base' : 'NOT FOUND')
if (!code || code === '0x') process.exit(1)

// The factory validates its own salt scheme, so ask it. generateSalt returns more
// than one word on this deployment, so take the first 32 bytes rather than decoding.
const saltData = encodeFunctionData({ abi, functionName: 'generateSalt', args: [DEPLOYER, NAME, SYMBOL, SUPPLY] })
const saltRaw = await call('eth_call', [{ to: FACTORY, data: saltData }, 'latest'])
const salt = '0x' + saltRaw.slice(2, 66)
console.log('generateSalt ', saltRaw.length, 'chars ->', salt)
try {
  const predicted = await call('eth_call', [{ to: FACTORY, data: encodeFunctionData({ abi, functionName: 'predictToken', args: [DEPLOYER, NAME, SYMBOL, SUPPLY, salt] }) }, 'latest'])
  console.log('token address', '0x' + predicted.slice(-40), '(predicted, counterfactual)')
} catch (e) {
  console.log('token address', 'predictToken reverted:', String(e.message).slice(0, 120))
}

const rawTick = getTickFromMarketCap(20) // ~20 ETH FDV at current price; adjust before deploying
const tick = typeof rawTick === 'object' && rawTick !== null ? (rawTick.tickIfToken0IsClanker ?? rawTick.tick) : rawTick
const rawFee = FEE_CONFIGS.StaticBasic
const lpFee = typeof rawFee === 'number' ? rawFee : (rawFee?.fee ?? rawFee?.[0]?.fee ?? 10_000)
console.log('rawTick      ', JSON.stringify(rawTick), '-> tick', tick)
console.log('rawFee       ', JSON.stringify(rawFee), '-> lpFee', lpFee)
const data = encodeFunctionData({
  abi, functionName: 'deployToken',
  args: [NAME, SYMBOL, SUPPLY, tick, lpFee, salt, DEPLOYER],
})
console.log('tick         ', tick, '| lpFee', lpFee, '| calldata', data.length, 'chars')

// Fund the deployer in an overridden world, then simulate the real call.
const overrides = {}
overrides[DEPLOYER] = { balance: toHex(10n * 10n ** 18n) }
try {
  const out = await call('eth_call', [{ from: DEPLOYER, to: FACTORY, data, gas: toHex(8_000_000n) }, 'latest', overrides])
  console.log('SIMULATION   success. returned', '0x' + out.slice(-40))
  console.log('\nThe deploy call would succeed against live Base state. Nothing was broadcast.')
} catch (e) {
  const msg = String(e.message)
  console.log('SIMULATION   would revert:', msg.slice(0, 300))
  if (/already|exist|salt/i.test(msg)) console.log('  -> salt/name already used, or predictToken collides. Expected for a repeated rehearsal.')
  if (/gas/i.test(msg)) console.log('  -> out of gas in override context; raise the gas field.')
  process.exitCode = 2
}
