/** Server-only Theta EdgeCloud configuration. Never import this module from browser code. */
export type ThetaConfig = {
  controllerBaseUrl: string
  projectId: string
  projectApiKey: string
  inferenceApiKey: string
  maxSpendUsdMicros: bigint
}

export function loadThetaConfig(env: Record<string, string | undefined>): ThetaConfig {
  const controllerBaseUrl = (env.THETA_CONTROLLER_URL || 'https://controller.thetaedgecloud.com').trim()
  const url = new URL(controllerBaseUrl)
  if (url.protocol !== 'https:' || url.hostname !== 'controller.thetaedgecloud.com' || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('THETA_CONTROLLER_URL must be the official HTTPS Theta controller origin')
  }

  const projectId = (env.THETA_PROJECT_ID || '').trim()
  if (projectId && !/^[a-zA-Z0-9_-]{8,128}$/.test(projectId)) {
    throw new Error('THETA_PROJECT_ID has an invalid format')
  }

  const maxSpend = env.THETA_MAX_SPEND_USD_MICROS || '1000000'
  if (!/^\d+$/.test(maxSpend) || BigInt(maxSpend) < 0n) {
    throw new Error('THETA_MAX_SPEND_USD_MICROS must be a non-negative integer')
  }

  return {
    controllerBaseUrl: url.origin,
    projectId,
    projectApiKey: env.THETA_PROJECT_API_KEY || '',
    inferenceApiKey: env.THETA_ONDEMAND_API_KEY || '',
    maxSpendUsdMicros: BigInt(maxSpend),
  }
}

export function assertThetaCredentials(config: ThetaConfig, kind: 'project' | 'inference'): void {
  const key = kind === 'project' ? config.projectApiKey : config.inferenceApiKey
  if (!key) throw new Error(`Theta ${kind} credential is not configured`)
}
