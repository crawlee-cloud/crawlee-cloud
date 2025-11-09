"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { 
  LayoutDashboard, 
  Play, 
  Drama, 
  Database, 
  Settings, 
  BookOpen
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/runs", label: "Runs", icon: Play },
  { href: "/actors", label: "Actors", icon: Drama },
  { href: "/datasets", label: "Datasets", icon: Database },
];

const secondaryItems = [
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/docs", label: "Documentation", icon: BookOpen },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 flex flex-col h-screen sticky top-0 border-r border-white/5 bg-black/40 backdrop-blur-xl">
      <div className="p-6 flex items-center gap-3">
        <div className="relative group">
          <div className="absolute inset-0 bg-linear-to-br from-indigo-500 via-purple-500 to-pink-500 rounded-xl blur opacity-40 group-hover:opacity-60 transition-opacity" />
          <div className="relative h-9 w-9 bg-black/50 border border-white/10 rounded-xl flex items-center justify-center text-white font-bold text-sm shadow-xl backdrop-blur-md">
            CP
          </div>
        </div>
        <span className="font-bold text-lg tracking-tight bg-linear-to-r from-white to-white/60 bg-clip-text text-transparent">
          Crawlee
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
        <nav className="space-y-1">
          {navItems.map((item) => {
            const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group relative overflow-hidden",
                  isActive 
                    ? "text-white" 
                    : "text-muted-foreground hover:text-white"
                )}
              >
                {isActive && (
                  <div className="absolute inset-0 bg-white/5 border border-white/5 rounded-lg" />
                )}
                <item.icon className={cn("h-4 w-4 transition-colors", isActive ? "text-indigo-400" : "text-muted-foreground group-hover:text-white")} />
                <span className="relative">{item.label}</span>
                {isActive && (
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-indigo-500 rounded-full shadow-[0_0_8px_rgba(99,102,241,0.5)]" />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="mt-8 pt-4 border-t border-white/5">
          <p className="px-3 text-[10px] font-semibold text-muted-foreground mb-2 uppercase tracking-widest text-white/20">
            System
          </p>
          <nav className="space-y-1">
            {secondaryItems.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group relative",
                    isActive 
                      ? "text-white bg-white/5" 
                      : "text-muted-foreground hover:text-white hover:bg-white/5"
                  )}
                >
                  <item.icon className={cn("h-4 w-4 transition-colors", isActive ? "text-indigo-400" : "text-muted-foreground group-hover:text-white")} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>

      <div className="p-4 mt-auto border-t border-white/5 mx-4 mb-4 rounded-xl bg-white/5 backdrop-blur-sm border border-white/5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-full bg-linear-to-br from-zinc-800 to-zinc-900 border border-white/10 flex items-center justify-center text-xs font-semibold text-white/60">
            ME
          </div>
          <div className="flex-1 overflow-hidden">
            <p className="text-sm font-medium text-white/80 truncate">User Workspace</p>
            <p className="text-[10px] text-emerald-400 truncate flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Pro Plan
            </p>
          </div>
        </div>
        <div className="flex justify-center border-t border-white/5 pt-3">
            <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}
