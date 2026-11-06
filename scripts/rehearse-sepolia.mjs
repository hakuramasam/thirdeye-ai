#!/usr/bin/env node
/**
 * Base Sepolia rehearsal for the THIRDEYE launch flow.
 *
 * Rehearses the token deploy and the post-deploy wiring on testnet, with testnet
 * money, before anything irreversible happens on Base mainnet.
 *
 * Hard rule: a testnet chain must NEVER enter the production payment path. If
 * chain 84532 were registered in CHAINS, anyone could send free testnet USDC and
 * receive real credit, because a stablecoin is valued 1:1 with no oracle. So this
 * script is deliberately standalone: it talks to Sepolia RPC directly and never
 * writes to the production database or the production API.
 *
 * Usage:
 *   node scripts/rehearse-sepolia.mjs            # check prerequisites only
 *   node scripts/rehearse-sepolia.mjs --deploy   # deploy the test token (costs testnet gas)
 */
import { readFileSync, existsSync } from 'node:fs'

const SEPOLIA_CHAIN_ID = 84532
const DEFAULT_RPC = 'https://sepolia.base.org'
// Circle's official USDC on Base Sepolia.
const DEFAULT_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

function loadEnv() {
  for (const f of ['../.env.production.local', '.env.production.local', '.env']) {
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
  }
}
loadEnv()

const rpc = process.env.SEPOLIA_RPC || DEFAULT_RPC
const usdc = process.env.SEPOLIA_USDC || DEFAULT_USDC
const key = process.env.SEPOLIA_DEPLOYER_KEY || ''
const deploy = process.argv.includes('--deploy')

const call = async (method, params) => {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  })
  const j = await res.json()
  if (j.error) throw new Error(j.error.message)
  return j.result
}

const problems = []
const notes = []

let chainId = null
try {
  chainId = parseInt(await call('eth_chainId', []), 16)
  if (chainId !== SEPOLIA_CHAIN_ID) problems.push(`RPC ${rpc} is chain ${chainId}, expected Base Sepolia ${SEPOLIA_CHAIN_ID}`)
  else notes.push(`RPC ok: Base Sepolia ${chainId} via ${rpc}`)
} catch (e) {
  problems.push(`RPC unreachable (${rpc}): ${e.message}`)
}

let deployer = null
let balanceEth = 0
if (!key) {
  problems.push('SEPOLIA_DEPLOYER_KEY is not set (a dedicated testnet key, never the mainnet agent key)')
} else {
  try {
    const { privateKeyToAccount } = await import('viem/accounts')
    const acct = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
    deployer = acct.address
    balanceEth = Number(BigInt(await call('eth_getBalance', [deployer, 'latest']))) / 1e18
    notes.push(`deployer ${deployer} holds ${balanceEth} testnet ETH`)
    if (balanceEth < 0.005) problems.push(`deployer has ${balanceEth} testnet ETH; a deploy plus pool setup needs about 0.005. Fund it from a Base Sepolia faucet`)
  } catch (e) {
    problems.push(`SEPOLIA_DEPLOYER_KEY is not a valid key: ${e.message}`)
  }
}

let solc = false
try {
  await import('solc')
  solc = true
  notes.push('solc available: the test token can be compiled here')
} catch {
  problems.push('no Solidity compiler: run `npm install --no-save solc` (the contract is compiled here, not on a laptop)')
}

// USDC on Sepolia must be a real contract, or the pool step is meaningless.
try {
  const code = await call('eth_getCode', [usdc, 'latest'])
  if (code && code !== '0x') notes.push(`test USDC contract present at ${usdc}`)
  else problems.push(`no contract at test USDC address ${usdc} on this network`)
} catch { problems.push('could not read the test USDC contract') }

console.log('\nBase Sepolia rehearsal: prerequisites\n')
for (const n of notes) console.log('  ok   ', n)
for (const p of problems) console.log('  TODO ', p)

if (problems.length) {
  console.log(`\n${problems.length} prerequisite(s) missing. Nothing was deployed and no production state was touched.`)
  process.exit(1)
}

console.log('\nAll prerequisites met.', deploy ? 'Proceeding to deploy.' : 'Run with --deploy to deploy the test token.')
if (deploy) console.log('Deploy step not implemented yet: it lands in the next change, once solc and testnet gas are confirmed.')
