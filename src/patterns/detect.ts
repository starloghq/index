import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { KnownCategorySchema, type KnownCategory } from '../manifest/schema.js';
import type { PatternSignal } from './schema.js';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.turbo',
  '.starlog',
  'vendor',
  '__pycache__',
]);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export interface DetectionHit {
  category: KnownCategory;
  confidence: number;
  signals: PatternSignal[];
}

interface CategoryRule {
  category: KnownCategory;
  pathPatterns: RegExp[];
  importPatterns: RegExp[];
  keywordPatterns: RegExp[];
  knownLibPatterns: RegExp[];
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    category: 'authentication',
    pathPatterns: [/auth/i, /session/i, /jwt/i, /login/i, /password/i],
    importPatterns: [
      /\bjsonwebtoken\b/,
      /\bbcrypt(js)?\b/,
      /\bjose\b/,
      /from\s+['"]passport['"]/,
      /verifyToken|signToken|hashPassword|comparePassword/,
    ],
    keywordPatterns: [/\bJWT\b/, /\bOAuth\b/, /\bsession\s*token\b/i],
    knownLibPatterns: [
      /@clerk\//,
      /\bauth0\b/,
      /next-auth/,
      /@supabase\/supabase-js/,
      /@supabase\/auth-js/,
      /lucia/,
      /better-auth/,
    ],
  },
  {
    category: 'feature-flags',
    pathPatterns: [/feature.?flag/i, /flags?\//i],
    importPatterns: [/featureFlag|isFeatureEnabled|getFlag/],
    keywordPatterns: [/feature\s+flag/i],
    knownLibPatterns: [/launchdarkly/, /posthog/, /flagsmith/, /@configcat/],
  },
  {
    category: 'caching',
    pathPatterns: [/cache/i, /redis/i],
    importPatterns: [/\bnode-cache\b/, /createCache|memoizeTTL/],
    keywordPatterns: [/\bin-?memory\s+cache\b/i],
    knownLibPatterns: [/\bioredis\b/, /\bkeyv\b/, /@upstash\/redis/],
  },
  {
    category: 'realtime',
    pathPatterns: [/websocket/i, /realtime/i, /socket/i],
    importPatterns: [/\bws\b/, /WebSocket/, /socket\.io/],
    keywordPatterns: [/\bwebsocket\b/i],
    knownLibPatterns: [/socket\.io/, /@supabase\/realtime/, /pusher-js/, /ably/],
  },
  {
    category: 'background-jobs',
    pathPatterns: [/queue/i, /worker/i, /jobs?\//i],
    importPatterns: [/\bbullmq\b/, /\bbull\b/, /createQueue|processJob/],
    keywordPatterns: [/\bjob\s+queue\b/i, /\bbackground\s+job/i],
    knownLibPatterns: [/bullmq/, /inngest/, /\bbree\b/],
  },
  {
    category: 'email',
    pathPatterns: [/email/i, /mailer/i, /smtp/i],
    importPatterns: [/nodemailer/, /sendMail|transporter\.send/],
    keywordPatterns: [/\bsmtp\b/i],
    knownLibPatterns: [/resend/, /@sendgrid/, /nodemailer/],
  },
  {
    category: 'orm-database',
    pathPatterns: [/database/i, /db\//i, /migrations?\//i, /schema\.ts$/i],
    importPatterns: [/knex\(|createPool|rawQuery|sqlite3/],
    keywordPatterns: [/\bORM\b/, /\bSQL\s+builder\b/i],
    knownLibPatterns: [/\bprisma\b/, /\bdrizzle-orm\b/, /\bkysely\b/],
  },
];

const CATEGORY_KEYWORDS: Record<KnownCategory, string[]> = {
  authentication: ['auth', 'login', 'session', 'jwt', 'oauth', 'password', 'signin', 'signup'],
  'feature-flags': ['feature flag', 'feature toggle', 'rollout', 'experiment'],
  caching: ['cache', 'redis', 'memoize', 'ttl'],
  realtime: ['realtime', 'websocket', 'live', 'push'],
  'background-jobs': ['background job', 'queue', 'worker', 'cron', 'scheduler'],
  email: ['email', 'smtp', 'transactional mail', 'mailer'],
  'orm-database': ['database', 'orm', 'sql', 'query builder', 'migration'],
};

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop()!.toLowerCase() : '';
      if (SOURCE_EXTENSIONS.has(ext)) out.push(join(dir, entry.name));
    }
  }

  await walk(root);
  return out;
}

function scoreRule(rule: CategoryRule, relPath: string, content: string): { score: number; signals: PatternSignal[] } {
  const signals: PatternSignal[] = [];
  let score = 0;

  for (const re of rule.pathPatterns) {
    if (re.test(relPath)) {
      score += 2;
      signals.push({ kind: 'path', value: relPath });
      break;
    }
  }

  for (const re of rule.importPatterns) {
    if (re.test(content)) {
      score += 3;
      signals.push({ kind: 'import', value: re.source.replace(/\\b/g, '').slice(0, 40) });
    }
  }

  for (const re of rule.keywordPatterns) {
    if (re.test(content)) {
      score += 1;
      signals.push({ kind: 'keyword', value: re.source });
    }
  }

  const hasKnownLib = rule.knownLibPatterns.some((re) => re.test(content));
  if (hasKnownLib) {
    score = 0;
    signals.push({ kind: 'absence', value: 'known-library-present' });
  }

  return { score, signals };
}

/**
 * Detect the single best-matching DIY capability category for ONE file's
 * content. Cheap and synchronous (no filesystem walk) — this is the tripwire
 * gate for the `after_file_edit` hook, which sees one edited file at a time and
 * must decide in milliseconds whether it's worth any further work. Returns null
 * when nothing clears the confidence floor (score < 3) or a known library is
 * already present. Mirrors `scanProject`'s per-file scoring exactly.
 */
export function detectFile(relPath: string, content: string): DetectionHit | null {
  // Bound the hot path: an oversized edit (e.g. a generated bundle) shouldn't
  // run every rule's regexes over megabytes. Unlike scanProject — which skips
  // big files outright because other files still cover the category — the
  // tripwire sees only THIS file, so we scan a head slice rather than skip, and
  // still catch signals near the top. 512KB matches scanProject's cap.
  const scanned = content.length > 512_000 ? content.slice(0, 512_000) : content;
  let best: DetectionHit | null = null;
  for (const rule of CATEGORY_RULES) {
    const { score, signals } = scoreRule(rule, relPath, scanned);
    if (score < 3) continue;
    const confidence = Math.min(100, score * 15);
    if (!best || confidence > best.confidence) {
      best = {
        category: rule.category,
        confidence,
        signals: [...signals, { kind: 'path', value: relPath }],
      };
    }
  }
  return best;
}

/**
 * Scan a project directory for DIY capability patterns. Returns hits above a
 * minimum confidence threshold, one per category (best score wins).
 */
export async function scanProject(projectRoot: string): Promise<DetectionHit[]> {
  const files = await walkFiles(projectRoot);
  const byCategory = new Map<KnownCategory, DetectionHit>();

  for (const file of files) {
    let content: string;
    try {
      const st = await stat(file);
      if (st.size > 512_000) continue;
      content = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    const relPath = relative(projectRoot, file);

    for (const rule of CATEGORY_RULES) {
      const { score, signals } = scoreRule(rule, relPath, content);
      if (score < 3) continue;

      const hitSignals = [
        ...signals,
        { kind: 'path' as const, value: relPath },
      ];
      const confidence = Math.min(100, score * 15);
      const prev = byCategory.get(rule.category);
      if (!prev || confidence > prev.confidence) {
        byCategory.set(rule.category, {
          category: rule.category,
          confidence,
          signals: hitSignals,
        });
      }
    }
  }

  return [...byCategory.values()];
}

/** Map a free-text observation to the best-matching known category. */
export function categoryFromObservation(observation: string): KnownCategory | null {
  const lower = observation.toLowerCase();
  let best: { category: KnownCategory; score: number } | null = null;

  for (const category of KnownCategorySchema.options) {
    const keywords = CATEGORY_KEYWORDS[category];
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score += kw.includes(' ') ? 3 : 1;
    }
    if (!best || score > best.score) best = { category, score };
  }

  return best && best.score > 0 ? best.category : null;
}
