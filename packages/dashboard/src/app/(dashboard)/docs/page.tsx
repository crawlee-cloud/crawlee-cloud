import { Book, ExternalLink, Code, Terminal, Webhook, Database, ArrowUpRight } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";

const GITHUB_REPO = "https://github.com/crawlee-cloud/crawlee-cloud";
const CRAWLEE_DOCS = "https://crawlee.dev/docs";
const APIFY_DOCS = "https://docs.apify.com";

interface DocCard {
  title: string;
  description: string;
  icon: React.ElementType;
  iconColor: string;
  items: string[];
  href: string;
  external?: boolean;
}

const docCards: DocCard[] = [
  {
    title: "Getting Started",
    description: "Quick introduction to Crawlee Cloud",
    icon: Book,
    iconColor: "blue",
    items: ["Installation & Setup", "Creating your first Actor", "Running locally", "Deploying to production"],
    href: `${GITHUB_REPO}#quick-start`,
    external: true,
  },
  {
    title: "API Reference",
    description: "Complete REST API documentation",
    icon: Code,
    iconColor: "purple",
    items: ["Datasets API", "Key-Value Stores API", "Request Queues API", "Actors & Runs API"],
    href: "http://localhost:3000/documentation",
    external: true,
  },
  {
    title: "CLI Guide",
    description: "Command-line interface usage",
    icon: Terminal,
    iconColor: "green",
    items: ["crawlee-cloud create", "crawlee-cloud run", "crawlee-cloud push", "crawlee-cloud call"],
    href: `${GITHUB_REPO}/blob/main/packages/cli/README.md`,
    external: true,
  },
  {
    title: "Crawlee Framework",
    description: "Learn the underlying framework",
    icon: Webhook,
    iconColor: "orange",
    items: ["CheerioCrawler", "PlaywrightCrawler", "Request handling", "Data storage"],
    href: CRAWLEE_DOCS,
    external: true,
  },
  {
    title: "Self-Hosting",
    description: "Deploy on your infrastructure",
    icon: Database,
    iconColor: "cyan",
    items: ["Docker deployment", "Kubernetes setup", "Storage configuration", "Scaling guide"],
    href: `${GITHUB_REPO}/blob/main/docs/deployment.md`,
    external: true,
  },
  {
    title: "Bring Your Code",
    description: "Works with your existing Actors",
    icon: ExternalLink,
    iconColor: "pink",
    items: ["Zero-code migration", "Environment variables", "API compatibility", "Data export/import"],
    href: `${GITHUB_REPO}/blob/main/docs/README.md#zero-code-migration-from-apify`,
    external: true,
  },
];

function getColorClasses(color: string) {
  const colors: Record<string, { bg: string; text: string }> = {
    blue: { bg: "bg-blue-500/10", text: "text-blue-500" },
    purple: { bg: "bg-purple-500/10", text: "text-purple-500" },
    green: { bg: "bg-green-500/10", text: "text-green-500" },
    orange: { bg: "bg-orange-500/10", text: "text-orange-500" },
    cyan: { bg: "bg-cyan-500/10", text: "text-cyan-500" },
    pink: { bg: "bg-pink-500/10", text: "text-pink-500" },
  };
  return colors[color] ?? colors.blue;
}

export default function DocsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Documentation</h1>
        <p className="text-muted-foreground">Learn how to use Crawlee Cloud</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {docCards.map((card) => {
          const Icon = card.icon;
          const colors = getColorClasses(card.iconColor);
          
          return (
            <Link 
              key={card.title} 
              href={card.href}
              target={card.external ? "_blank" : undefined}
              rel={card.external ? "noopener noreferrer" : undefined}
              className="block"
            >
              <Card className="h-full hover:border-primary/50 hover:bg-white/5 transition-all cursor-pointer group">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className={`p-2 ${colors.bg} rounded-lg`}>
                        <Icon className={`h-5 w-5 ${colors.text}`} />
                      </div>
                      <CardTitle className="text-lg">{card.title}</CardTitle>
                    </div>
                    {card.external && (
                      <ArrowUpRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                    )}
                  </div>
                  <CardDescription>{card.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2 text-sm text-muted-foreground">
                    {card.items.map((item) => (
                      <li key={item}>• {item}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Quick Reference</CardTitle>
          <CardDescription>Common commands and endpoints</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h4 className="font-medium mb-2">API Base URL</h4>
            <code className="block p-3 bg-muted rounded-lg text-sm font-mono">
              http://localhost:3000/v2
            </code>
          </div>
          <div>
            <h4 className="font-medium mb-2">Environment Variables</h4>
            <code className="block p-3 bg-muted rounded-lg text-sm font-mono whitespace-pre">
{`APIFY_API_BASE_URL=http://localhost:3000/v2
APIFY_TOKEN=your-token
APIFY_IS_AT_HOME=1`}
            </code>
          </div>
          <div className="pt-2 flex gap-3">
            <Link 
              href={GITHUB_REPO}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              <span>View on GitHub</span>
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
            <Link 
              href={APIFY_DOCS}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              <span>Apify SDK Docs</span>
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
