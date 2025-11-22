/**
 * API client for Crawlee Platform.
 * 
 * Handles authenticated requests to the backend API.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export interface Run {
  id: string;
  actId: string;
  status: 'READY' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED-OUT' | 'ABORTING' | 'ABORTED';
  statusMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  defaultDatasetId?: string;
  defaultKeyValueStoreId?: string;
  defaultRequestQueueId?: string;
  timeoutSecs: number;
  memoryMbytes: number;
  createdAt: string;
  modifiedAt: string;
}

export interface Actor {
  id: string;
  name: string;
  title?: string;
  description?: string;
  userId?: string;
  defaultRunOptions?: Record<string, unknown>;
  createdAt: string;
  modifiedAt: string;
}

export interface Dataset {
  id: string;
  name?: string;
  userId?: string;
  itemCount: number;
  createdAt: string;
  modifiedAt: string;
  accessedAt: string;
}

export interface User {
  id: string;
  email: string;
  name?: string;
  role: string;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  name: string;
  keyPreview: string;
  isActive: boolean;
  createdAt: string;
  lastUsedAt?: string;
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('token');
}

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  
  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  }
  
  const res = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers,
  });
  
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: { message: 'Request failed' } }));
    throw new Error(error.error?.message || 'Request failed');
  }
  
  if (res.status === 204) {
    return {} as T;
  }
  
  return res.json();
}

// Auth
export async function getCurrentUser(): Promise<User> {
  const res = await fetchApi<{ data: User }>('/v2/auth/me');
  return res.data;
}

export async function getApiKeys(): Promise<ApiKey[]> {
  const res = await fetchApi<{ data: ApiKey[] }>('/v2/auth/api-keys');
  return res.data;
}

export async function createApiKey(name: string): Promise<{ id: string; name: string; key: string }> {
  const res = await fetchApi<{ data: { id: string; name: string; key: string } }>('/v2/auth/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return res.data;
}

export async function revokeApiKey(id: string): Promise<void> {
  await fetchApi(`/v2/auth/api-keys/${id}`, { method: 'DELETE' });
}

// Runs
export async function getRuns(): Promise<Run[]> {
  const res = await fetchApi<{ data: { items: Run[] } }>('/v2/actor-runs');
  return res.data.items;
}

export async function getRun(id: string): Promise<Run> {
  const res = await fetchApi<{ data: Run }>(`/v2/actor-runs/${id}`);
  return res.data;
}

export async function startRun(actorId: string, options?: { input?: unknown; timeout?: number; memory?: number }): Promise<Run> {
  const res = await fetchApi<{ data: Run }>(`/v2/acts/${actorId}/runs`, {
    method: 'POST',
    body: JSON.stringify({ 
      input: options?.input,
      timeout: options?.timeout,
      memory: options?.memory,
    }),
  });
  return res.data;
}

export async function abortRun(id: string): Promise<Run> {
  const res = await fetchApi<{ data: Run }>(`/v2/actor-runs/${id}/abort`, { method: 'POST' });
  return res.data;
}

export async function getActorRuns(actorId: string): Promise<Run[]> {
  // Get all runs and filter by actId
  const runs = await getRuns();
  return runs.filter(r => r.actId === actorId);
}

// Actors
export async function getActors(): Promise<Actor[]> {
  const res = await fetchApi<{ data: { items: Actor[] } }>('/v2/acts');
  return res.data.items;
}

export async function getActor(id: string): Promise<Actor> {
  const res = await fetchApi<{ data: Actor }>(`/v2/acts/${id}`);
  return res.data;
}

export async function createActor(data: {
  name: string;
  title?: string;
  description?: string;
}): Promise<Actor> {
  const res = await fetchApi<{ data: Actor }>('/v2/acts', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  return res.data;
}

export async function deleteActor(id: string): Promise<void> {
  await fetchApi(`/v2/acts/${id}`, { method: 'DELETE' });
}

// Datasets
export async function getDatasets(): Promise<Dataset[]> {
  const res = await fetchApi<{ data: { items: Dataset[] } }>('/v2/datasets');
  return res.data.items;
}

export async function getDataset(id: string): Promise<Dataset> {
  const res = await fetchApi<{ data: Dataset }>(`/v2/datasets/${id}`);
  return res.data;
}

export async function getDatasetItems(id: string, options?: { offset?: number; limit?: number }): Promise<unknown[]> {
  const params = new URLSearchParams();
  if (options?.offset !== undefined) params.append('offset', String(options.offset));
  if (options?.limit !== undefined) params.append('limit', String(options.limit));
  
  const queryString = params.toString() ? `?${params.toString()}` : '';
  // API returns array directly, not wrapped in { data: ... }
  const res = await fetchApi<unknown[]>(`/v2/datasets/${id}/items${queryString}`);
  return res;
}

export async function deleteDataset(id: string): Promise<void> {
  await fetchApi(`/v2/datasets/${id}`, { method: 'DELETE' });
}

// Stats (aggregated from other calls)
export async function getRunLogs(runId: string, options?: { offset?: number; limit?: number }): Promise<{ items: { timestamp: string; level: string; message: string }[] }> {
  const params = new URLSearchParams();
  if (options?.offset !== undefined) params.append('offset', String(options.offset));
  if (options?.limit !== undefined) params.append('limit', String(options.limit));
  
  const queryString = params.toString() ? `?${params.toString()}` : '';
  const res = await fetchApi<{ data: { items: { timestamp: string; level: string; message: string }[] } }>(`/v2/actor-runs/${runId}/logs${queryString}`);
  return res.data;
}

export async function getRunInput(runId: string): Promise<unknown> {
  try {
    // Get run info to find the default KV store
    const run = await getRun(runId);
    if (!run.defaultKeyValueStoreId) return null;
    
    // Fetch INPUT record from the KV store
    const res = await fetchApi<unknown>(`/v2/key-value-stores/${run.defaultKeyValueStoreId}/records/INPUT`);
    return res;
  } catch {
    return null;
  }
}

export async function getRunDatasetItems(runId: string, options?: { offset?: number; limit?: number }): Promise<unknown[]> {
  const params = new URLSearchParams();
  if (options?.offset !== undefined) params.append('offset', String(options.offset));
  if (options?.limit !== undefined) params.append('limit', String(options.limit));
  
  const queryString = params.toString() ? `?${params.toString()}` : '';
  try {
    const res = await fetchApi<unknown[]>(`/v2/actor-runs/${runId}/dataset/items${queryString}`);
    return res;
  } catch {
    return [];
  }
}

export async function getDashboardStats(): Promise<{
  totalRuns: number;
  activeActors: number;
  totalDatasets: number;
  successRate: number;
}> {
  try {
    const [runs, actors, datasets] = await Promise.all([
      getRuns().catch(() => []),
      getActors().catch(() => []),
      getDatasets().catch(() => []),
    ]);
    
    const succeeded = runs.filter(r => r.status === 'SUCCEEDED').length;
    const failed = runs.filter(r => r.status === 'FAILED').length;
    const successRate = succeeded + failed > 0 ? (succeeded / (succeeded + failed)) * 100 : 100;
    
    return {
      totalRuns: runs.length,
      activeActors: actors.length,
      totalDatasets: datasets.length,
      successRate: Math.round(successRate),
    };
  } catch {
    return { totalRuns: 0, activeActors: 0, totalDatasets: 0, successRate: 100 };
  }
}
