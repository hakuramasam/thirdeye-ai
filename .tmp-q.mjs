import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
const env = Object.fromEntries(readFileSync('.env.production.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))
process.env.DATABASE_URL = env.DATABASE_URL.replace(/^"|"$/g,'')
const sql = neon(process.env.DATABASE_URL)
const q = async (label, s) => { try { const r = await sql.query(s); console.log('###', label); console.log(JSON.stringify(r)); } catch(e) { console.log('###', label, 'ERR', e.message) } }
for (const [label, s] of Object.entries(JSON.parse(process.argv[2]))) await q(label, s)
