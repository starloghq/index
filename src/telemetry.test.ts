import { describe, it, expect } from 'vitest';
import { scrubText, parseState, needsNotice, isInternalUser, NOTICE_VERSION, TELEMETRY_NOTICE } from './telemetry.js';

/**
 * scrubText is the load-bearing privacy guard: verbatim query/context strings
 * pass through it before they ever reach PostHog. Benign developer text must
 * survive untouched (it's the product signal); anything that looks like PII or a
 * secret must be replaced with the ‹redacted› sentinel.
 */
describe('scrubText — PII/secret redaction for free-text telemetry', () => {
  const REDACTED = '‹redacted›';

  it('leaves a normal capability query untouched', () => {
    expect(scrubText('auth for Next.js SaaS')).toBe('auth for Next.js SaaS');
    expect(scrubText('background job queue for Node.js')).toBe('background job queue for Node.js');
  });

  it('does not over-redact hyphenated package names or "and/or"', () => {
    expect(scrubText('react-router vs @tanstack/router and/or wouter')).toBe('react-router vs @tanstack/router and/or wouter');
  });

  it('redacts an email address', () => {
    expect(scrubText('contact rragan@bishopfox.com about sso')).toBe(`contact ${REDACTED} about sso`);
  });

  it('redacts a GitHub token', () => {
    expect(scrubText('use ghp_abcdefghijklmnopqrstuvwxyz0123456789 here')).toBe(`use ${REDACTED} here`);
  });

  it('redacts an AWS access key id', () => {
    expect(scrubText('key AKIAIOSFODNN7EXAMPLE rotates')).toBe(`key ${REDACTED} rotates`);
  });

  it('redacts an OpenAI-style and Bearer secret', () => {
    expect(scrubText('sk-abcdefghijklmnopqrstuvwxyz012345')).toBe(REDACTED);
    expect(scrubText('header Bearer eyJhbGciOiJIUzI1NiJ9.foo.bar')).toBe(`header ${REDACTED}`);
  });

  it('redacts an absolute unix path and a ~ path but not a single slash', () => {
    expect(scrubText('error in /Users/rragan/secret-proj/index.ts now')).toBe(`error in ${REDACTED} now`);
    expect(scrubText('read ~/work/internal/config.json')).toBe(`read ${REDACTED}`);
    expect(scrubText('TLS and/or mTLS')).toBe('TLS and/or mTLS'); // lone-ish slash survives
  });

  it('redacts a Windows path', () => {
    expect(scrubText('at C:\\Users\\rragan\\proj\\app.ts')).toBe(`at ${REDACTED}`);
  });

  it('redacts an IPv4 address', () => {
    expect(scrubText('connect to 10.0.12.34 internal')).toBe(`connect to ${REDACTED} internal`);
  });

  it('redacts a long base64/hex secret blob', () => {
    expect(scrubText('token deadbeefcafebabedeadbeefcafebabe1234')).toBe('token ‹redacted›');
  });

  it('handles empty / whitespace input without throwing', () => {
    expect(scrubText('')).toBe('');
    expect(scrubText('   ')).toBe('   ');
  });
});

describe('consent notice versioning (re-consent on upgrade)', () => {
  it('parseState defaults a legacy/empty state to noticeVersion 0 (so the new notice re-shows)', () => {
    expect(parseState({}).noticeVersion).toBe(0);
    expect(parseState({ noticeShown: true }).noticeVersion).toBe(0); // legacy field, no version → re-consent
    expect(parseState(null).noticeVersion).toBe(0);
  });

  it('parseState reads an explicit noticeVersion and preserves enabled/anonymousId', () => {
    const s = parseState({ anonymousId: 'abc', enabled: false, noticeVersion: NOTICE_VERSION });
    expect(s.noticeVersion).toBe(NOTICE_VERSION);
    expect(s.enabled).toBe(false);
    expect(s.anonymousId).toBe('abc');
  });

  it('needsNotice is true when the seen version is older than current, false when current', () => {
    expect(needsNotice(parseState({ noticeVersion: 0 }))).toBe(true);
    expect(needsNotice(parseState({ noticeVersion: NOTICE_VERSION - 1 }))).toBe(true);
    expect(needsNotice(parseState({ noticeVersion: NOTICE_VERSION }))).toBe(false);
  });

  it('the notice honestly discloses query/context capture and drops the old "never queries" promise', () => {
    expect(TELEMETRY_NOTICE.toLowerCase()).toContain('quer'); // discloses query capture
    expect(TELEMETRY_NOTICE.toLowerCase()).toContain('package');
    expect(TELEMETRY_NOTICE.toLowerCase()).not.toContain('never your queries');
  });
});

describe('isInternalUser — $internal_or_test_user opt-in (STARLOG_INTERNAL)', () => {
  it('is true only for truthy STARLOG_INTERNAL values', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'On']) {
      expect(isInternalUser({ STARLOG_INTERNAL: v })).toBe(true);
    }
  });

  it('is false when unset or explicitly falsy (default: not internal)', () => {
    expect(isInternalUser({})).toBe(false);
    for (const v of ['', '0', 'false', 'no', 'off']) {
      expect(isInternalUser({ STARLOG_INTERNAL: v })).toBe(false);
    }
  });
});
