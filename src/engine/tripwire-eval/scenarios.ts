// Scenarios for the tripwire decision-flip eval (.planning/tripwire-eval.md).
//
// Each is a realistic mid-task state where an agent has just hand-rolled DIY
// code for a capability a vetted library covers, chosen for GENUINE AMBIGUITY —
// a competent engineer could plausibly continue DIY or reach for a library.
// Obvious-library or obvious-DIY tasks would ceiling/floor the signal.

export interface EvalScenario {
  id: string;
  category: string;
  /** The coding task the agent is working on. */
  task: string;
  /** The DIY code the agent has just written (its current state). */
  diyState: string;
  /** The vetted library the tripwire would steer toward (grader reference / arm C). */
  vettedLib: string;
  /** Concrete migrate advice for arm C (the "advice inlined" arm). */
  inlineAdvice: string;
}

export const SCENARIOS: EvalScenario[] = [
  {
    id: 'auth-jwt-express',
    category: 'authentication',
    task: 'Add email/password login with sessions to a small Express + Postgres SaaS app.',
    diyState: `// auth.ts
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
export async function hashPassword(pw: string) { return bcrypt.hash(pw, 10); }
export function signSession(userId: string) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET!, { expiresIn: '7d' });
}
// TODO: refresh tokens, password reset, email verification, session revocation`,
    vettedLib: 'Clerk / Auth0 / better-auth',
    inlineAdvice:
      'Migrate to Clerk: install @clerk/nextjs, replace custom sign-in/up routes with Clerk components, remove custom JWT signing + password hashing, use clerkMiddleware for protected routes. This removes the whole refresh-token/reset/verification TODO list.',
  },
  {
    id: 'cache-inmemory-ttl',
    category: 'caching',
    task: 'Add a cache with TTL in front of a slow external API call in a Node service.',
    diyState: `// cache.ts
const store = new Map<string, { value: unknown; expires: number }>();
export function set(key: string, value: unknown, ttlMs: number) {
  store.set(key, { value, expires: Date.now() + ttlMs });
}
export function get(key: string) {
  const e = store.get(key);
  if (!e || e.expires < Date.now()) return undefined;
  return e.value;
}
// TODO: eviction, size limits, stale-while-revalidate, multi-instance sharing`,
    vettedLib: 'keyv / ioredis / @upstash/redis',
    inlineAdvice:
      'Use keyv (in-memory now, swap to Redis later with one adapter change) or @upstash/redis for shared cache. Gets you eviction, TTL, and multi-instance sharing without hand-rolling.',
  },
  {
    id: 'jobs-queue-worker',
    category: 'background-jobs',
    task: 'Process image uploads asynchronously so the request returns immediately.',
    diyState: `// queue.ts
const jobs: Array<() => Promise<void>> = [];
export function enqueue(job: () => Promise<void>) { jobs.push(job); }
setInterval(async () => {
  const job = jobs.shift();
  if (job) await job().catch(console.error);
}, 1000);
// TODO: retries, backoff, persistence across restarts, concurrency, dead-letter`,
    vettedLib: 'BullMQ / Inngest',
    inlineAdvice:
      'Use BullMQ (Redis-backed) or Inngest (serverless). You get retries, backoff, persistence across restarts, concurrency control, and a dead-letter queue — all the TODOs — instead of an in-memory array that loses jobs on restart.',
  },
  {
    id: 'email-smtp-transactional',
    category: 'email',
    task: 'Send transactional emails (welcome, password reset) from a Node app.',
    diyState: `// mailer.ts
import nodemailer from 'nodemailer';
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: 587,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});
export function send(to: string, subject: string, html: string) {
  return transporter.sendMail({ from: 'no-reply@app.com', to, subject, html });
}
// TODO: templates, retries, bounce/complaint handling, deliverability/SPF/DKIM`,
    vettedLib: 'Resend / SendGrid',
    inlineAdvice:
      'Use Resend or SendGrid: managed deliverability (SPF/DKIM), templates, retries, and bounce/complaint webhooks — the things raw SMTP via nodemailer makes you build and monitor yourself.',
  },
  {
    id: 'flags-env-toggles',
    category: 'feature-flags',
    task: 'Add feature flags so we can roll out a new checkout flow to 10% of users.',
    diyState: `// flags.ts
const FLAGS: Record<string, boolean> = { newCheckout: process.env.NEW_CHECKOUT === '1' };
export function isEnabled(flag: string) { return FLAGS[flag] ?? false; }
export function forUser(flag: string, userId: string) {
  // crude percentage rollout by hashing the user id
  return (hash(userId) % 100) < 10 && isEnabled(flag);
}
// TODO: runtime updates without redeploy, targeting rules, audit, kill switch`,
    vettedLib: 'LaunchDarkly / PostHog / Flagsmith',
    inlineAdvice:
      'Use PostHog or LaunchDarkly: change rollout % at runtime without a redeploy, targeting rules, audit log, and an instant kill switch — vs. env-var flags that need a deploy to change.',
  },
  {
    id: 'realtime-ws-broadcast',
    category: 'realtime',
    task: 'Push live notifications to connected web clients.',
    diyState: `// ws.ts
import { WebSocketServer } from 'ws';
const wss = new WebSocketServer({ port: 8080 });
const clients = new Set<import('ws').WebSocket>();
wss.on('connection', (s) => { clients.add(s); s.on('close', () => clients.delete(s)); });
export function broadcast(msg: unknown) {
  for (const c of clients) c.send(JSON.stringify(msg));
}
// TODO: reconnection, auth, rooms/channels, scaling across instances, presence`,
    vettedLib: 'Socket.IO / Ably / Pusher',
    inlineAdvice:
      'Use Socket.IO (self-host) or Ably/Pusher (managed): reconnection, auth, rooms/channels, presence, and cross-instance scaling out of the box — vs. a raw ws Set that only works on one process and drops clients on disconnect.',
  },
];
