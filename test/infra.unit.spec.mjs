// Checks on the CloudFormation template that a live deploy would otherwise be
// the first thing to catch. Both cases below actually failed a real deploy.

import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

import { OVERPASS_ENDPOINTS } from '../src/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// CloudFormation's !Ref / !GetAtt / !Sub tags are not standard YAML.
const CFN_TAGS = ['Ref', 'GetAtt', 'Sub', 'If', 'And', 'Or', 'Not', 'Equals', 'Join', 'Select', 'Split', 'FindInMap', 'Base64', 'ImportValue', 'Condition']
  .flatMap((tag) => [
    { tag: `!${tag}`, collection: 'seq', resolve: (v) => v },
    { tag: `!${tag}`, resolve: (v) => v },
  ]);

const template = yaml.parse(await readFile(resolve(ROOT, 'infra/cloudfront.yaml'), 'utf8'), {
  customTags: CFN_TAGS,
});

const csp = template.Resources.SecurityHeadersPolicy
  .Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig
  .ContentSecurityPolicy.ContentSecurityPolicy;

test.describe('CloudFront response headers policy', () => {
  test('the CSP is a single line', () => {
    // A more-indented line inside a YAML folded block keeps its newline, and
    // CloudFront rejects any header value containing one — the deploy fails at
    // resource creation with "contains illegal characters".
    expect(csp).not.toMatch(/[\r\n]/);
  });

  test('connect-src covers every Overpass mirror the app can call', () => {
    // The CSP had drifted: it still allowed a mirror that had been removed and
    // did not allow the two that replaced it, so "Refresh from OpenStreetMap"
    // would have been blocked in production while working perfectly locally.
    for (const url of OVERPASS_ENDPOINTS) {
      const origin = new URL(url).origin;
      expect(csp, `CSP is missing ${origin}`).toContain(origin);
    }
  });

  test('allows the tile and glyph hosts the basemaps use', () => {
    for (const host of [
      'https://tile.openstreetmap.org',
      'https://*.tile.opentopomap.org',
      'https://fonts.openmaptiles.org',
    ]) {
      expect(csp).toContain(host);
    }
  });

  test('allows the whole media pipeline: Wikidata, Wikipedia and Commons', () => {
    // Three fetch targets (entity claims, article summaries, Commons geosearch)
    // and three image origins — the Commons thumbnail redirects to
    // upload.wikimedia.org and Wikipedia lead images come from *.wikipedia.org,
    // so a missing host here breaks imagery only in production.
    const connect = csp.match(/connect-src[^;]+/)[0];
    const img = csp.match(/img-src[^;]+/)[0];
    for (const host of ['https://www.wikidata.org', 'https://commons.wikimedia.org', 'https://*.wikipedia.org']) {
      expect(connect, `connect-src missing ${host}`).toContain(host);
    }
    for (const host of ['https://commons.wikimedia.org', 'https://upload.wikimedia.org', 'https://*.wikipedia.org']) {
      expect(img, `img-src missing ${host}`).toContain(host);
    }
  });

  test('keeps the restrictive directives that make the policy worth having', () => {
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    // MapLibre cannot start without blob: workers.
    expect(csp).toContain("worker-src 'self' blob:");
    // No wildcard script source.
    expect(csp).not.toMatch(/script-src[^;]*\*/);
  });
});

test.describe('template shape', () => {
  test('the bucket stays private and versioned', () => {
    const b = template.Resources.SiteBucket.Properties;
    expect(b.PublicAccessBlockConfiguration.BlockPublicPolicy).toBe(true);
    expect(b.PublicAccessBlockConfiguration.RestrictPublicBuckets).toBe(true);
    expect(b.VersioningConfiguration.Status).toBe('Enabled');
    // Lifecycle rules live under LifecycleConfiguration; `LifecycleRules` is not
    // a property of AWS::S3::Bucket and fails changeset validation.
    expect(b.LifecycleRules).toBeUndefined();
    expect(b.LifecycleConfiguration.Rules.length).toBeGreaterThan(0);
  });

  test('pmtiles are served uncompressed so byte ranges work', () => {
    const basemap = template.Resources.Distribution.Properties.DistributionConfig
      .CacheBehaviors.find((b) => b.PathPattern === '/basemap/*');
    expect(basemap).toBeDefined();
    expect(basemap.Compress).toBe(false);
  });

  test('DNS alias records point at the CloudFront hosted zone', () => {
    const sets = template.Resources.DnsRecords.Properties.RecordSets;
    expect(sets.map((s) => s.Type).sort()).toEqual(['A', 'AAAA']);
    for (const s of sets) {
      // Fixed, documented zone id for all CloudFront distributions. Substituting
      // the account's own zone id here produces records that resolve nowhere.
      expect(s.AliasTarget.HostedZoneId).toBe('Z2FDTNDATAQYW2');
    }
  });
});
