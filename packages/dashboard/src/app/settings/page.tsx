"use client";

import { Save, RefreshCw, CheckCircle2, Shield, HardDrive, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function SettingsPage() {
  return (
    <div className="space-y-8 animate-in fade-in duration-500 max-w-5xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight bg-linear-to-r from-white to-white/60 bg-clip-text text-transparent">Settings</h1>
        <p className="text-muted-foreground mt-1 text-sm">
           System configuration and integrations
        </p>
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
                value="http://localhost:3000" 
                readOnly 
                className="bg-white/5 border-white/10 text-muted-foreground font-mono" 
              />
            </div>
            
            <div className="grid gap-2">
              <label className="text-sm font-medium text-white/80">Access Token</label>
              <div className="flex gap-3">
                <Input 
                  type="password" 
                  value="crawlee_ver_secure_token_placeholder" 
                  readOnly 
                  className="bg-white/5 border-white/10 text-muted-foreground font-mono flex-1" 
                />
                <Button variant="outline" className="border-white/10 hover:bg-white/5 text-indigo-400 hover:text-indigo-300">
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Regenerate
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">This token grants full admin access. Keep it secure.</p>
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

        <div className="flex justify-end pt-4">
          <Button size="lg" className="bg-white text-black hover:bg-white/90 shadow-[0_0_20px_rgba(255,255,255,0.2)]">
            <Save className="mr-2 h-4 w-4" />
            Save Configuration
          </Button>
        </div>
      </div>
    </div>
  );
}
