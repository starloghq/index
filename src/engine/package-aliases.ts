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
  'better-auth': 'better-auth',
  passport: 'passport',
  lucia: 'lucia',
  'firebase-auth': 'firebase',
  'aws-cognito': '@aws-sdk/client-cognito-identity-provider',
  ioredis: 'ioredis',
  keyv: 'keyv',
  'upstash-redis': '@upstash/redis',
  'node-redis': 'redis',
  'lru-cache': 'lru-cache',
  unstorage: 'unstorage',
  bullmq: 'bullmq',
  inngest: 'inngest',
  bree: 'bree',
  'pg-boss': 'pg-boss',
  'trigger-dev': '@trigger.dev/sdk',
  'graphile-worker': 'graphile-worker',
  resend: 'resend',
  sendgrid: '@sendgrid/mail',
  nodemailer: 'nodemailer',
  postmark: 'postmark',
  mailgun: 'mailgun.js',
  'amazon-ses': '@aws-sdk/client-ses',
  prisma: '@prisma/client',
  drizzle: 'drizzle-orm',
  kysely: 'kysely',
  typeorm: 'typeorm',
  sequelize: 'sequelize',
  mongoose: 'mongoose',
  knex: 'knex',
  'postgres-js': 'postgres',
  launchdarkly: '@launchdarkly/node-server-sdk',
  posthog: 'posthog-node',
  flagsmith: 'flagsmith',
  configcat: 'configcat-node',
  devcycle: '@devcycle/nodejs-server-sdk',
  growthbook: '@growthbook/growthbook',
  unleash: 'unleash-client',
  openfeature: '@openfeature/server-sdk',
  'socket-io': 'socket.io',
  ably: 'ably',
  pusher: 'pusher',
  'supabase-realtime': '@supabase/supabase-js',
  ws: 'ws',
  yjs: 'yjs',
  mqtt: 'mqtt',
  liveblocks: '@liveblocks/client',
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
