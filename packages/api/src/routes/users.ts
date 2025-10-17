/**
 * Users routes - Apify-compatible endpoints for user info.
 * 
 * These endpoints are used by the Apify client during initialization.
 */

import type { FastifyPluginAsync } from 'fastify';

export const usersRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /v2/users/me - Get current user info
   * 
   * This is called by Apify client during Actor.init() for charging/billing.
   * We return a minimal response to allow the actor to continue.
   */
  fastify.get('/users/me', async () => {
    return {
      data: {
        id: 'anonymous',
        username: 'anonymous',
        profile: {},
        isPaidUser: false,
        plan: 'FREE',
      },
    };
  });
  
  /**
   * GET /v2/users/me/limits - Get user limits
   */
  fastify.get('/users/me/limits', async () => {
    return {
      data: {
        maxConcurrentRuns: 100,
        maxMemoryMbytes: 32768,
      },
    };
  });
};
