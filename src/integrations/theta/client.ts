import type { ThetaConfig } from './config.js'
import { assertThetaCredentials } from './config.js'

/**
 * Read-only controller transport foundation.
 *
 * Endpoint paths and authentication headers are intentionally not guessed here. They must be
 * implemented from the current official Theta GPU Node API v1 contract before use.
 */
export class ThetaReadOnlyClient {
  constructor(
    private readonly config: ThetaConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get<T>(path: string, credential: 'project' = 'project'): Promise<T> {
    assertThetaCredentials(this.config, credential)
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('..') || path.includes('?') || path.includes('#')) {
      throw new Error('Theta API path must be a fixed absolute path')
    }
    throw new Error('Theta API endpoint and authentication contract must be verified before enabling requests')
  }

  /** Exposes only non-secret configuration for diagnostics. */
  describe(): { controllerOrigin: string; projectId: string; authenticated: boolean } {
    return {
      controllerOrigin: this.config.controllerBaseUrl,
      projectId: this.config.projectId,
      authenticated: Boolean(this.config.projectApiKey),
    }
  }
}
