import { Redis } from 'ioredis';
import { config } from './config.js';

export class ActorScheduler {
  private redis: Redis;
  
  constructor() {
    this.redis = new Redis(config.redisUrl);
  }
  
  async scheduleActor(actorId: string, runId: string, input?: any): Promise<void> {
    const job = {
      actorId,
      runId, 
      input,
      scheduledAt: new Date().toISOString(),
      status: 'scheduled'
    };
    
    await this.redis.lpush('actor_queue', JSON.stringify(job));
  }
  
  async getNextJob(): Promise<any | null> {
    const jobData = await this.redis.brpop('actor_queue', 0);
    
    if (!jobData) return null;
    
    return JSON.parse(jobData[1]);
  }
  
  async markJobCompleted(runId: string): Promise<void> {
    await this.redis.hset('actor_runs', runId, JSON.stringify({
      status: 'completed',
      completedAt: new Date().toISOString()
    }));
  }
  
  async markJobFailed(runId: string, error: string): Promise<void> {
    await this.redis.hset('actor_runs', runId, JSON.stringify({
      status: 'failed', 
      failedAt: new Date().toISOString(),
      error
    }));
  }
  
  async getJobStatus(runId: string): Promise<any | null> {
    const jobData = await this.redis.hget('actor_runs', runId);
    
    if (!jobData) return null;
    
    return JSON.parse(jobData);
  }
}
