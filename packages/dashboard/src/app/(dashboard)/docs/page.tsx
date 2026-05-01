import { ArrowUpRight, Book, Code, Database, ExternalLink, Terminal, Webhook } from 'lucide-react';
import Link from 'next/link';

const GITHUB_REPO = 'https://github.com/crawlee-cloud/crawlee-cloud';
const SITE_DOCS = 'https://crawlee.cloud/docs';
const CRAWLEE_DOCS = 'https://crawlee.dev/docs';
const APIFY_DOCS = 'https://docs.apify.com';

interface DocCard {
  title: string;
  description: string;
  icon: React.ElementType;
  items: string[];
  href: string;
}

const docCards: DocCard[] = [
  {
    title: 'Getting started',
    description: 'Quick introduction to Crawlee Cloud.',
    icon: Book,
    items: [
      'Installation & setup',
      'Creating your first actor',
      'Running locally',
      'Deploying to production',
    ],
    href: `${SITE_DOCS}/quickstart-tutorial`,
  },
  {
    title: 'API reference',
    description: 'Complete REST API documentation.',
    icon: Code,
    items: ['Datasets API', 'Key-Value Stores API', 'Request Queues API', 'Actors & Runs API'],
    href: `${SITE_DOCS}/api`,
  },
  {
    title: 'CLI guide',
    description: 'Command-line interface usage. Multi-environment profiles + healthcheck.',
    icon: Terminal,
    items: [
      'crc login --profile <env>',
      'crc profile list / use / rm',
      'crc info — active profile + server health',
      'crc push, run, call, logs',
    ],
    href: `${SITE_DOCS}/cli`,
  },
  {
    title: 'Crawlee framework',
    description: 'Learn the underlying scraping framework.',
    icon: Webhook,
    items: ['CheerioCrawler', 'PlaywrightCrawler', 'Request handling', 'Data storage'],
    href: CRAWLEE_DOCS,
  },
  {
    title: 'Self-hosting',
    description: 'Deploy on your infrastructure.',
    icon: Database,
    items: ['Docker deployment', 'Storage configuration', 'Runner setup', 'Production hardening'],
    href: `${SITE_DOCS}/deployment`,
  },
  {
    title: 'Bring your code',
    description: 'Existing Apify actors run unmodified.',
    icon: ExternalLink,
    items: [
      'Apify SDK environment',
      'Environment variables',
      'API compatibility',
      'Zero-code migration',
    ],
    href: `${SITE_DOCS}/apify-sdk-environment`,
  },
];

export default function DocsPage() {
  return (
    <div className="space-y-8">
      <header className="pb-4 border-b border-border">
        <p className="eyebrow mb-2">SYSTEM · DOCUMENTATION</p>
        <h1 className="text-[28px] leading-none font-medium tracking-tight">Documentation</h1>
        <p className="text-muted-foreground mt-2 text-[13px]">
          Operating manual for Crawlee Cloud. External links open in a new tab.
        </p>
      </header>

      <ul className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {docCards.map((card) => {
          const Icon = card.icon;
          return (
            <li key={card.title}>
              <Link
                href={card.href}
                target="_blank"
                rel="noopener noreferrer"
                className="block panel p-5 h-full hover:border-signal/40 transition-colors group"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="h-8 w-8 rounded-sm border border-border bg-secondary/60 grid place-items-center text-muted-foreground group-hover:text-signal group-hover:border-signal/40 transition-colors">
                    <Icon className="h-4 w-4" />
                  </div>
                  <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
                <h3 className="text-[15px] text-foreground group-hover:text-signal transition-colors">
                  {card.title}
                </h3>
                <p className="text-[12px] text-muted-foreground mt-1">{card.description}</p>
                <ul className="mt-4 space-y-1 text-[12px] text-muted-foreground font-mono">
                  {card.items.map((item) => (
                    <li key={item} className="flex items-center gap-2">
                      <span className="text-signal/60">▸</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </Link>
            </li>
          );
        })}
      </ul>

      {/* Quick reference */}
      <section className="panel">
        <header className="px-5 py-4 border-b border-border">
          <p className="eyebrow">REFERENCE · CHEAT SHEET</p>
          <h2 className="text-[15px] mt-1">Common values</h2>
        </header>
        <div className="p-5 space-y-4">
          <div>
            <p className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase mb-1.5">
              API base URL
            </p>
            <pre className="panel bg-background p-3 font-mono text-[12px] text-foreground">
              http://localhost:3000/v2
            </pre>
          </div>
          <div>
            <p className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase mb-1.5">
              Apify-compat env vars
            </p>
            <pre className="panel bg-background p-3 font-mono text-[12px] text-foreground whitespace-pre">
              {`APIFY_API_BASE_URL=http://localhost:3000/v2
APIFY_TOKEN=your-token
APIFY_IS_AT_HOME=1`}
            </pre>
          </div>
          <div className="flex flex-wrap gap-3 pt-2 border-t border-border">
            <Link
              href={GITHUB_REPO}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[12px] text-foreground hover:text-signal transition-colors"
            >
              <span>github.com/crawlee-cloud</span>
              <ArrowUpRight className="h-3 w-3" />
            </Link>
            <Link
              href={APIFY_DOCS}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[12px] text-foreground hover:text-signal transition-colors"
            >
              <span>Apify SDK docs</span>
              <ArrowUpRight className="h-3 w-3" />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
