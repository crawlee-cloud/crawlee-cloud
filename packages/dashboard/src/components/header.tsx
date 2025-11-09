"use client";

import { Bell, Search, Command } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Header() {
  return (
    <header className="h-16 px-6 flex items-center justify-between gap-4 sticky top-0 z-10">
       {/* Glass background separate from content to allow masking/complex effects if needed, or just standard bg */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-xl border-b border-white/5 pointer-events-none" />

      <div className="flex items-center gap-4 flex-1 relative z-20">
        <div className="relative max-w-md w-full md:w-80 group">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground group-focus-within:text-indigo-400 transition-colors" />
          <input
            type="search"
            placeholder="Search resources..."
            className="w-full h-10 rounded-lg border border-white/5 bg-white/5 pl-10 pr-12 py-1 text-sm text-white shadow-sm transition-all placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500/50 focus-visible:bg-white/10"
          />
          <div className="absolute right-3 top-2.5 flex items-center gap-1 pointer-events-none">
            <span className="text-[10px] text-muted-foreground bg-white/5 px-1.5 py-0.5 rounded border border-white/5">⌘ K</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 relative z-20">
        <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-white hover:bg-white/5 relative">
          <Bell className="h-5 w-5" />
          <span className="absolute top-2 right-2 w-2 h-2 bg-indigo-500 rounded-full border-2 border-black" />
        </Button>
      </div>
    </header>
  );
}
