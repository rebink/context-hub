export const DEPLOYMENT_CONTRACT = {
  schemaVersion: 1,
  compatibilityDate: "2025-02-14",
  requiredSecrets: [
    "GITHUB_CLIENT_SECRET",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
    "PILOT_GITHUB_USER_ID_HASHES",
  ],
  gateCommands: {
    test: "npm test",
    typecheck: "npm run typecheck",
    lint: "npm run lint",
    build: "npm run build",
    architectureQa: "npm run qa:architecture",
    localE2e: "npm run test:e2e:local",
    migrationIntegrity: "npm run test:migrations -w @context-hub/api",
    securityAudit: "npm audit --omit=dev --offline",
    freeTierAudit: "npm run audit:free-tier",
  },
  limits: {
    manifestBytes: 65536,
    receiptBytes: 16384,
    childOutputBytes: 524288,
    childTimeoutMs: 120000,
    terminationGraceMs: 1000,
    finalCloseDeadlineMs: 1500,
    workerGzipBytes: 3145728,
    workerBytes: 67108864,
  },
  patterns: {
    sha: "^[0-9a-f]{40}$",
    digest: "^[0-9a-f]{64}$",
    semver: "^[0-9]+\\.[0-9]+\\.[0-9]+$",
    accountId: "^[0-9a-f]{32}$",
    uuid: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    resourceName: "^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$",
    owner: "^[A-Za-z0-9][A-Za-z0-9 ._@+-]{2,79}$",
    githubClientId: "^(?:Iv1\\.[0-9a-f]{16}|Ov23li[A-Za-z0-9]{14,})$",
    githubAppId: "^[1-9][0-9]{0,19}$",
    receiptPath: "^\\.deployment/receipts/[a-z][a-z0-9-]{1,40}\\.json$",
    repositoryReference: "^docs/[A-Za-z0-9._/-]+(?:#[A-Za-z0-9._-]+)?$",
  },
} as const;

const gateProperties = Object.fromEntries(
  Object.keys(DEPLOYMENT_CONTRACT.gateCommands).map((key) => [
    key,
    { $ref: "#/$defs/receiptPath" },
  ]),
);

export const DEPLOYMENT_MANIFEST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:context-hub:production-deployment-manifest:v1",
  title: "Context Hub production deployment manifest",
  description:
    "Nonsecret immutable production candidate inputs. Cross-field origin, reserved-host, identifier-quality, receipt-content, and secret-pattern constraints are enforced by deploy:preflight.",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "profile",
    "release",
    "cloudflare",
    "github",
    "requiredSecrets",
    "tooling",
    "gates",
  ],
  properties: {
    schemaVersion: { const: DEPLOYMENT_CONTRACT.schemaVersion },
    profile: { enum: ["CUSTOM_DOMAIN", "FREE_PILOT"] },
    release: {
      type: "object",
      additionalProperties: false,
      required: [
        "commit",
        "branch",
        "changeId",
        "changeWindow",
        "owners",
        "incidentRunbook",
        "rollbackRunbook",
      ],
      properties: {
        commit: { $ref: "#/$defs/sha" },
        branch: { const: "main" },
        changeId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$" },
        changeWindow: {
          type: "object",
          additionalProperties: false,
          required: ["startsAt", "endsAt"],
          properties: {
            startsAt: { type: "string", format: "date-time" },
            endsAt: { type: "string", format: "date-time" },
          },
        },
        owners: {
          type: "object",
          additionalProperties: false,
          required: ["release", "cloudflare", "github", "security", "incident"],
          properties: {
            release: { $ref: "#/$defs/owner" },
            cloudflare: { $ref: "#/$defs/owner" },
            github: { $ref: "#/$defs/owner" },
            security: { $ref: "#/$defs/owner" },
            incident: { $ref: "#/$defs/owner" },
          },
        },
        incidentRunbook: { $ref: "#/$defs/repositoryReference" },
        rollbackRunbook: { $ref: "#/$defs/repositoryReference" },
      },
    },
    cloudflare: {
      type: "object",
      additionalProperties: false,
      required: ["accountId", "zoneId", "worker", "d1", "r2", "pages"],
      properties: {
        accountId: { $ref: "#/$defs/accountId" },
        zoneId: { $ref: "#/$defs/accountId" },
        worker: {
          type: "object",
          additionalProperties: false,
          required: [
            "name",
            "environment",
            "apiOrigin",
            "route",
            "workersDev",
            "workersDevSubdomain",
            "previewUrls",
            "compatibilityDate",
            "observability",
          ],
          properties: {
            name: { $ref: "#/$defs/resourceName" },
            environment: { const: "production" },
            apiOrigin: { $ref: "#/$defs/httpsOrigin" },
            route: {
              type: "object",
              additionalProperties: false,
              required: ["pattern", "customDomain"],
              properties: {
                pattern: { $ref: "#/$defs/hostname" },
                customDomain: { type: "boolean" },
              },
            },
            workersDev: { type: "boolean" },
            workersDevSubdomain: { $ref: "#/$defs/resourceName" },
            previewUrls: { const: false },
            compatibilityDate: { const: DEPLOYMENT_CONTRACT.compatibilityDate },
            observability: {
              type: "object",
              additionalProperties: false,
              required: ["enabled", "headSamplingRate", "policyReference"],
              properties: {
                enabled: { const: true },
                headSamplingRate: { type: "number", exclusiveMinimum: 0, maximum: 0.1 },
                policyReference: { $ref: "#/$defs/repositoryReference" },
              },
            },
          },
        },
        d1: {
          type: "object",
          additionalProperties: false,
          required: ["binding", "databaseName", "databaseId"],
          properties: {
            binding: { const: "DB" },
            databaseName: { $ref: "#/$defs/resourceName" },
            databaseId: { $ref: "#/$defs/uuid" },
          },
        },
        r2: {
          type: "object",
          additionalProperties: false,
          required: ["binding", "bucketName", "private", "r2Dev", "customDomains", "corsRules"],
          properties: {
            binding: { const: "OBJECTS" },
            bucketName: { $ref: "#/$defs/resourceName" },
            private: { const: true },
            r2Dev: { const: false },
            customDomains: { type: "array", maxItems: 0 },
            corsRules: { type: "array", maxItems: 0 },
          },
        },
        pages: {
          type: "object",
          additionalProperties: false,
          required: [
            "projectName",
            "productionBranch",
            "webOrigin",
            "apiPublicVariable",
            "previewDeployments",
          ],
          properties: {
            projectName: { $ref: "#/$defs/resourceName" },
            productionBranch: { const: "main" },
            webOrigin: { $ref: "#/$defs/httpsOrigin" },
            apiPublicVariable: { const: "VITE_API_URL" },
            previewDeployments: { const: false },
          },
        },
      },
    },
    github: {
      type: "object",
      additionalProperties: false,
      required: [
        "oauthClientId",
        "oauthCallback",
        "appId",
        "appSlug",
        "appClientId",
        "appSetupUrl",
        "appCallback",
        "oauthScopes",
        "appPermissions",
        "environment",
        "environmentProtectionReference",
      ],
      properties: {
        oauthClientId: { $ref: "#/$defs/githubClientId" },
        oauthCallback: { $ref: "#/$defs/httpsUrl" },
        appId: { $ref: "#/$defs/githubAppId" },
        appSlug: { $ref: "#/$defs/resourceName" },
        appClientId: { $ref: "#/$defs/githubClientId" },
        appSetupUrl: { $ref: "#/$defs/httpsUrl" },
        appCallback: { $ref: "#/$defs/httpsUrl" },
        oauthScopes: { type: "array", maxItems: 0 },
        appPermissions: {
          type: "object",
          additionalProperties: false,
          required: ["metadata", "contents"],
          properties: { metadata: { const: "read" }, contents: { const: "read" } },
        },
        environment: { const: "production" },
        environmentProtectionReference: { $ref: "#/$defs/repositoryReference" },
      },
    },
    requiredSecrets: { const: DEPLOYMENT_CONTRACT.requiredSecrets },
    tooling: {
      type: "object",
      additionalProperties: false,
      required: ["node", "npm", "wrangler", "lockfileSha256", "actions"],
      properties: {
        node: { $ref: "#/$defs/semver" },
        npm: { $ref: "#/$defs/semver" },
        wrangler: { $ref: "#/$defs/semver" },
        lockfileSha256: { $ref: "#/$defs/digest" },
        actions: {
          type: "object",
          additionalProperties: { $ref: "#/$defs/sha" },
          minProperties: 2,
          maxProperties: 8,
        },
      },
    },
    gates: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(DEPLOYMENT_CONTRACT.gateCommands),
      properties: gateProperties,
    },
  },
  allOf: [
    {
      if: { properties: { profile: { const: "CUSTOM_DOMAIN" } } },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
      then: {
        properties: {
          cloudflare: {
            properties: {
              worker: {
                properties: {
                  workersDev: { const: false },
                  route: { properties: { customDomain: { const: true } } },
                },
              },
            },
          },
        },
      },
    },
    {
      if: { properties: { profile: { const: "FREE_PILOT" } } },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
      then: {
        properties: {
          cloudflare: {
            properties: {
              worker: {
                properties: {
                  workersDev: { const: true },
                  route: { properties: { customDomain: { const: false } } },
                },
              },
            },
          },
        },
      },
    },
  ],
  $defs: {
    sha: { type: "string", pattern: DEPLOYMENT_CONTRACT.patterns.sha },
    digest: { type: "string", pattern: DEPLOYMENT_CONTRACT.patterns.digest },
    semver: { type: "string", pattern: DEPLOYMENT_CONTRACT.patterns.semver },
    accountId: { type: "string", pattern: DEPLOYMENT_CONTRACT.patterns.accountId },
    uuid: { type: "string", pattern: DEPLOYMENT_CONTRACT.patterns.uuid },
    resourceName: { type: "string", pattern: DEPLOYMENT_CONTRACT.patterns.resourceName },
    owner: { type: "string", pattern: DEPLOYMENT_CONTRACT.patterns.owner },
    githubClientId: { type: "string", pattern: DEPLOYMENT_CONTRACT.patterns.githubClientId },
    githubAppId: { type: "string", pattern: DEPLOYMENT_CONTRACT.patterns.githubAppId },
    receiptPath: { type: "string", pattern: DEPLOYMENT_CONTRACT.patterns.receiptPath },
    repositoryReference: {
      type: "string",
      pattern: DEPLOYMENT_CONTRACT.patterns.repositoryReference,
    },
    hostname: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9.-]{1,251}[a-z0-9])?$" },
    httpsOrigin: { type: "string", pattern: "^https://[a-z0-9.-]+$" },
    httpsUrl: { type: "string", pattern: "^https://[a-z0-9.-]+/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$" },
  },
} as const;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function generatedManifestSchema(): string {
  return `${JSON.stringify(DEPLOYMENT_MANIFEST_SCHEMA, null, 2)}\n`;
}
