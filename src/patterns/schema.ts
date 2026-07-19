import { z } from 'zod/v4';
import { CategorySchema, KnownCategorySchema } from '../manifest/schema.js';

export const PatternStatusSchema = z.enum([
  'watching',
  'advised_migrate',
  'advised_packageize',
  'applied',
]);
export type PatternStatus = z.infer<typeof PatternStatusSchema>;

export const PatternSignalSchema = z.object({
  kind: z.enum(['path', 'import', 'keyword', 'absence']),
  value: z.string(),
});
export type PatternSignal = z.infer<typeof PatternSignalSchema>;

export const PatternRecordSchema = z.object({
  id: z.string(),
  // Free-form category so niche PACKAGEIZE paths (no curated corpus) can be tracked.
  category: CategorySchema,
  fingerprint: z.string(),
  signals: z.array(PatternSignalSchema),
  occurrences: z.number().int().min(1),
  first_seen: z.string(),
  last_seen: z.string(),
  status: PatternStatusSchema,
  source_projects: z.array(z.string()).optional(),
});
export type PatternRecord = z.infer<typeof PatternRecordSchema>;

export const PatternStoreSchema = z.object({
  patterns: z.array(PatternRecordSchema),
});
export type PatternStore = z.infer<typeof PatternStoreSchema>;

export const AdviseActionSchema = z.enum(['migrate', 'packageize', 'watch']);
export type AdviseAction = z.infer<typeof AdviseActionSchema>;

export const SafeCandidateSchema = z.object({
  manifest_id: z.string(),
  name: z.string(),
  package_name: z.string(),
  relevance_score: z.number(),
  facts_available: z.boolean(),
});
export type SafeCandidate = z.infer<typeof SafeCandidateSchema>;

export const PackageizePlanSchema = z.object({
  suggested_name: z.string(),
  steps: z.array(z.string()),
});
export type PackageizePlan = z.infer<typeof PackageizePlanSchema>;

export const AdviseResultSchema = z.object({
  action: AdviseActionSchema,
  category: CategorySchema,
  rationale: z.string(),
  pattern_id: z.string().optional(),
  occurrences: z.number().int().optional(),
  candidates: z.array(SafeCandidateSchema).optional(),
  packageize_plan: PackageizePlanSchema.optional(),
  playbook_steps: z.array(z.string()),
  signals: z.array(PatternSignalSchema).optional(),
});
export type AdviseResult = z.infer<typeof AdviseResultSchema>;

/** Minimum occurrences (across sessions/projects) before recommending action. */
export const RECURRENCE_THRESHOLD = 2;

export { KnownCategorySchema };
