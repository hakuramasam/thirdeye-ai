// Official channel URLs for the browser bundle.
//
// The canonical copy lives in src/routes/public.ts, which renders the server-side pages. The two bundles
// cannot import each other, so the values are duplicated here and tests/official-links.test.ts fails if
// they diverge. Change both, or the build tells you.
export const X_URL = 'https://x.com/Thirdeye_Infra'
export const TELEGRAM_URL = 'https://t.me/Thirdeye_AI_Bot'
export const ABUND_URL = 'https://abund.ai/agent/thirdeye'
