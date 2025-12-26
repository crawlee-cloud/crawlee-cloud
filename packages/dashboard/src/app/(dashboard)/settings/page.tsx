'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Copy,
  RefreshCw,
  CheckCircle2,
  Shield,
  HardDrive,
  Settings2,
  Plus,
  Trash2,
  Eye,
  EyeOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface ApiKey {
  id: string;
  name: string;
  key_preview: string;
  created_at: string;
  last_used_at: string | null;
  is_active: boolean;
}

interface ApiKeysResponse {
  data: ApiKey[];
}

interface CreateKeyResponse {
  data: {
    id: string;
    name: string;
    key: string;
    message: string;
  };
}

export default function SettingsPage() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showNewKey, setShowNewKey] = useState(false);
  const [copied, setCopied] = useState(false);

  const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

  const getAuthToken = useCallback((): string | null => {
    const cookies = document.cookie.split(';');
    const tokenCookie = cookies.find((c) => c.trim().startsWith('token='));
    return tokenCookie ? tokenCookie.split('=')[1] : null;
  }, []);

  const fetchApiKeys = useCallback(async () => {
    try {
      const token = getAuthToken();
      if (!token) return;

      const response = await fetch(`${API_BASE}/v2/auth/api-keys`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (response.ok) {
        const data = (await response.json()) as ApiKeysResponse;
        setApiKeys(data.data);
      }
    } catch (error) {
      console.error('Failed to fetch API keys:', error);
    } finally {
      setLoading(false);
    }
  }, [API_BASE, getAuthToken]);

  const createApiKey = useCallback(async () => {
    if (!newKeyName.trim()) return;

    setCreating(true);
    try {
      const token = getAuthToken();
      if (!token) return;

      const response = await fetch(`${API_BASE}/v2/auth/api-keys`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: newKeyName }),
      });

      if (response.ok) {
        const data = (await response.json()) as CreateKeyResponse;
        setNewlyCreatedKey(data.data.key);
        setNewKeyName('');
        await fetchApiKeys();
      }
    } catch (error) {
      console.error('Failed to create API key:', error);
    } finally {
      setCreating(false);
    }
  }, [API_BASE, getAuthToken, newKeyName, fetchApiKeys]);

  const revokeApiKey = useCallback(
    async (keyId: string) => {
      try {
        const token = getAuthToken();
        if (!token) return;

        const response = await fetch(`${API_BASE}/v2/auth/api-keys/${keyId}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.ok) {
          await fetchApiKeys();
        }
      } catch (error) {
        console.error('Failed to revoke API key:', error);
      }
    },
    [API_BASE, getAuthToken, fetchApiKeys]
  );

  const copyToClipboard = useCallback((text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  }, []);

  const handleCreateClick = useCallback(() => {
    void createApiKey();
  }, [createApiKey]);

  const handleRevokeClick = useCallback(
    (keyId: string) => {
      void revokeApiKey(keyId);
    },
    [revokeApiKey]
  );

  useEffect(() => {
    void fetchApiKeys();
  }, [fetchApiKeys]);

  return (
    <div className="space-y-8 animate-in fade-in duration-500 max-w-5xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight bg-linear-to-r from-white to-white/60 bg-clip-text text-transparent">
          Settings
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">System configuration and integrations</p>
      </div>

      <div className="grid gap-8">
        {/* API Configuration */}
        <Card className="border-white/10 bg-black/20 backdrop-blur-sm">
          <CardHeader>
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
                <Shield className="h-5 w-5 text-indigo-400" />
              </div>
              <div>
                <CardTitle>API Access</CardTitle>
                <CardDescription>Connection details for external tools (CLI, SDKs)</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-2">
              <label className="text-sm font-medium text-white/80">API Base URL</label>
              <Input
                value={API_BASE}
                readOnly
                className="bg-white/5 border-white/10 text-muted-foreground font-mono"
              />
            </div>

            {/* New API Key Section */}
            {newlyCreatedKey && (
              <div className="p-4 border border-emerald-500/30 rounded-xl bg-emerald-500/10 space-y-3">
                <div className="flex items-center gap-2 text-emerald-400 text-sm font-medium">
                  <CheckCircle2 className="h-4 w-4" />
                  New API Key Created
                </div>
                <p className="text-xs text-muted-foreground">
                  Copy this key now. You won&apos;t be able to see it again!
                </p>
                <div className="flex gap-2">
                  <Input
                    type={showNewKey ? 'text' : 'password'}
                    value={newlyCreatedKey}
                    readOnly
                    className="bg-black/30 border-white/10 text-white font-mono flex-1"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="border-white/10 hover:bg-white/5"
                    onClick={() => {
                      setShowNewKey(!showNewKey);
                    }}
                  >
                    {showNewKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="outline"
                    className="border-white/10 hover:bg-white/5"
                    onClick={() => {
                      copyToClipboard(newlyCreatedKey);
                    }}
                  >
                    {copied ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                    {copied ? 'Copied!' : 'Copy'}
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => {
                    setNewlyCreatedKey(null);
                  }}
                >
                  Dismiss
                </Button>
              </div>
            )}

            {/* Create New Key */}
            <div className="grid gap-2">
              <label className="text-sm font-medium text-white/80">Create New API Key</label>
              <div className="flex gap-3">
                <Input
                  placeholder="Key name (e.g., 'CLI Access')"
                  value={newKeyName}
                  onChange={(e) => {
                    setNewKeyName(e.target.value);
                  }}
                  className="bg-white/5 border-white/10 text-white flex-1"
                />
                <Button
                  onClick={handleCreateClick}
                  disabled={creating || !newKeyName.trim()}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white"
                >
                  {creating ? (
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-2 h-4 w-4" />
                  )}
                  Generate Key
                </Button>
              </div>
            </div>

            {/* Existing Keys */}
            <div className="grid gap-2">
              <label className="text-sm font-medium text-white/80">Active API Keys</label>
              {loading ? (
                <div className="p-4 text-center text-muted-foreground text-sm">Loading keys...</div>
              ) : apiKeys.length === 0 ? (
                <div className="p-4 border border-white/5 rounded-xl bg-white/5 text-center text-muted-foreground text-sm">
                  No API keys yet. Create one above to get started.
                </div>
              ) : (
                <div className="space-y-2">
                  {apiKeys
                    .filter((k) => k.is_active)
                    .map((key) => (
                      <div
                        key={key.id}
                        className="flex items-center justify-between p-3 border border-white/5 rounded-xl bg-white/5"
                      >
                        <div className="space-y-0.5">
                          <div className="font-medium text-white/90">{key.name}</div>
                          <div className="text-xs text-muted-foreground font-mono">
                            {key.key_preview}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                          onClick={() => {
                            handleRevokeClick(key.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Storage Configuration */}
        <Card className="border-white/10 bg-black/20 backdrop-blur-sm">
          <CardHeader>
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-lg bg-purple-500/10 border border-purple-500/20">
                <HardDrive className="h-5 w-5 text-purple-400" />
              </div>
              <div>
                <CardTitle>Storage Backends</CardTitle>
                <CardDescription>Connected data persistence services</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between p-4 border border-white/5 rounded-xl bg-white/5">
              <div className="space-y-0.5">
                <div className="font-medium text-white/90">PostgreSQL</div>
                <div className="text-xs text-muted-foreground">Primary metadata storage</div>
              </div>
              <Badge variant="success" className="gap-1.5 pl-1.5 pr-2.5">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Connected
              </Badge>
            </div>

            <div className="flex items-center justify-between p-4 border border-white/5 rounded-xl bg-white/5">
              <div className="space-y-0.5">
                <div className="font-medium text-white/90">Redis</div>
                <div className="text-xs text-muted-foreground">Job queue & caching layer</div>
              </div>
              <Badge variant="success" className="gap-1.5 pl-1.5 pr-2.5">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Connected
              </Badge>
            </div>

            <div className="flex items-center justify-between p-4 border border-white/5 rounded-xl bg-white/5">
              <div className="space-y-0.5">
                <div className="font-medium text-white/90">MinIO / S3</div>
                <div className="text-xs text-muted-foreground">Dataset & Key-Value storage</div>
              </div>
              <Badge variant="success" className="gap-1.5 pl-1.5 pr-2.5">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Connected
              </Badge>
            </div>
          </CardContent>
        </Card>

        {/* Runner Configuration */}
        <Card className="border-white/10 bg-black/20 backdrop-blur-sm">
          <CardHeader>
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-lg bg-pink-500/10 border border-pink-500/20">
                <Settings2 className="h-5 w-5 text-pink-400" />
              </div>
              <div>
                <CardTitle>Execution Defaults</CardTitle>
                <CardDescription>Global configuration for new Actor runs</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="space-y-2">
                <label className="text-sm font-medium text-white/80">Concurrency Limit</label>
                <Input
                  type="number"
                  defaultValue={10}
                  className="bg-white/5 border-white/10 text-white"
                />
                <p className="text-[10px] text-muted-foreground">Max simultaneous runs</p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-white/80">Default Memory (MB)</label>
                <Input
                  type="number"
                  defaultValue={1024}
                  className="bg-white/5 border-white/10 text-white"
                />
                <p className="text-[10px] text-muted-foreground">Container memory limit</p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-white/80">Default Timeout (s)</label>
                <Input
                  type="number"
                  defaultValue={3600}
                  className="bg-white/5 border-white/10 text-white"
                />
                <p className="text-[10px] text-muted-foreground">Hard execution limit</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
