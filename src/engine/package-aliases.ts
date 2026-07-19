import type { CapabilityManifest } from '../manifest/schema.js';

/**
 * Map corpus manifest ids to npm package names for starlog_facts vetting.
 * Falls back to manifest id when no alias exists.
 */
export const MANIFEST_PACKAGE_ALIASES: Record<string, string> = {
  clerk: '@clerk/nextjs',
  auth0: '@auth0/nextjs-auth0',
  'supabase-auth': '@supabase/supabase-js',
  nextauth: 'next-auth',
  passport: 'passport',
  lucia: 'lucia',
  'firebase-auth': 'firebase',
  'aws-cognito': '@aws-sdk/client-cognito-identity-provider',
  ioredis: 'ioredis',
  keyv: 'keyv',
  'upstash-redis': '@upstash/redis',
  bullmq: 'bullmq',
  inngest: 'inngest',
  bree: 'bree',
  resend: 'resend',
  sendgrid: '@sendgrid/mail',
  nodemailer: 'nodemailer',
  prisma: '@prisma/client',
  drizzle: 'drizzle-orm',
  kysely: 'kysely',
  launchdarkly: '@launchdarkly/node-server-sdk',
  posthog: 'posthog-node',
  flagsmith: 'flagsmith',
  configcat: 'configcat-node',
  devcycle: '@devcycle/nodejs-server-sdk',
  'socket-io': 'socket.io',
  ably: 'ably',
  pusher: 'pusher',
  'supabase-realtime': '@supabase/supabase-js',
  ws: 'ws',
  cacheable: 'cacheable',
};

export function packageNameForManifest(manifest: CapabilityManifest): string {
  return MANIFEST_PACKAGE_ALIASES[manifest.id] ?? manifest.id;
}

/** Manifest ids that represent DIY / build-from-scratch — never safe migration targets. */
export const DIY_MANIFEST_IDS = new Set(['custom-authentication']);

export function isDiyManifest(manifest: CapabilityManifest): boolean {
  if (DIY_MANIFEST_IDS.has(manifest.id)) return true;
  if (manifest.repo === null && manifest.id.includes('custom')) return true;
  return false;
}
