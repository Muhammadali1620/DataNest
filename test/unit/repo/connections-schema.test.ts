// The JSON schema the editor uses for `.vscode/datanest.json` (V4.7) must describe
// exactly what the code reads, or people get completion for fields that are ignored.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONNECTION_COLORS,
  DRIVER_IDS,
  FILTER_LIMITS,
  MAX_REDIS_NODES,
  MAX_SSH_JUMPS,
  OPTION_LIMITS,
  REDIS_MODES,
  SSH_AUTH_METHODS,
  SSL_MODES,
} from '../../../src/shared/connection';
import {
  connectionInputShape,
  filterSchema,
  optionsSchema,
  redisSchema,
  sshHopShape,
} from '../../../src/shared/connection-schema';
import { PROJECT_FILE_PATH } from '../../../src/services/project-connections';
import { readJson, ROOT } from '../../helpers/repo';

interface JsonSchema {
  readonly type?: string;
  readonly enum?: readonly unknown[];
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly maxItems?: number;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly definitions?: Readonly<Record<string, JsonSchema>>;
  readonly items?: JsonSchema;
}

const manifest = readJson('package.json') as {
  contributes: { jsonValidation?: { fileMatch: string; url: string }[] };
};
const [validation] = manifest.contributes.jsonValidation ?? [];
const schema = readJson(validation?.url.replace(/^\.\//, '') ?? 'missing') as JsonSchema;
const connection = schema.definitions?.connection ?? {};
const hop = schema.definitions?.hop ?? {};
const props = connection.properties ?? {};

const keys = (value: object | undefined): string[] => Object.keys(value ?? {}).sort();

describe('connections JSON schema', () => {
  it('is contributed for the project file and ships in resources/', () => {
    expect(validation?.fileMatch).toBe(PROJECT_FILE_PATH);
    expect(validation?.url).toMatch(/^\.\/resources\//);
    expect(existsSync(join(ROOT, validation?.url ?? 'missing'))).toBe(true);
  });

  it('lists every connection field the code reads, plus the id, and nothing else', () => {
    expect(keys(props)).toEqual([...Object.keys(connectionInputShape), 'id'].sort());
    expect(connection.additionalProperties).toBe(false);
    expect(connection.required).toEqual(['name', 'driver']);
  });

  it('has no password field: secrets never go into a shared file', () => {
    expect(JSON.stringify(schema)).not.toMatch(/"password"\s*:\s*\{/);
  });

  it('offers the same choices as the code', () => {
    expect(props.driver?.enum).toEqual([...DRIVER_IDS]);
    // Oracle joined in V6.4, Redis in V7.1: a project file may name them.
    expect(props.driver?.enum).toContain('oracle');
    expect(props.driver?.enum).toContain('redis');
    expect(props.color?.enum).toEqual([...CONNECTION_COLORS]);
    expect(props.ssl?.properties?.mode?.enum).toEqual([...SSL_MODES]);
    expect(hop.properties?.auth?.enum).toEqual([...SSH_AUTH_METHODS]);
  });

  it('describes SSH hops as the code does, with jumps on the server only', () => {
    expect(keys(hop.properties)).toEqual(Object.keys(sshHopShape).sort());
    expect(keys(props.ssh?.properties)).toEqual([...Object.keys(sshHopShape), 'jumps'].sort());
    expect(props.ssh?.properties?.jumps?.maxItems).toBe(MAX_SSH_JUMPS);
    expect(hop.required).toEqual(['host', 'user', 'auth']);
  });

  it('describes the session options with the limits the code checks (V4.9)', () => {
    const options = props.options?.properties ?? {};
    const all = {
      connectTimeout: 1,
      queryTimeout: 0,
      keepAlive: 0,
      initSql: '',
      timeZone: '',
      charset: '',
    };
    // Every key the schema lists is one the code reads, and the other way round.
    expect(keys(optionsSchema.parse(all))).toEqual(keys(options));
    for (const name of ['connectTimeout', 'queryTimeout', 'keepAlive'] as const) {
      const limits = options[name] as { minimum?: number; maximum?: number };
      expect([limits.minimum, limits.maximum], name).toEqual([
        OPTION_LIMITS[name].min,
        OPTION_LIMITS[name].max,
      ]);
    }
    expect(props.options?.additionalProperties).toBe(false);
  });

  it('describes the visibility filter with the limits the code checks (V4.10)', () => {
    const filter = props.filter?.properties ?? {};
    expect(keys(filterSchema.parse({ databases: ['a'], schemas: ['b'] }))).toEqual(keys(filter));
    for (const list of Object.values(filter)) {
      expect(list.maxItems).toBe(FILTER_LIMITS.patterns);
      expect((list.items as { maxLength?: number }).maxLength).toBe(FILTER_LIMITS.pattern);
    }
  });

  it('describes the Redis settings as the code reads them, without the Sentinel password (V7.1)', () => {
    const redis = props.redis ?? {};
    const parsed = redisSchema.parse({
      mode: 'sentinel',
      masterName: 'm',
      nodes: [{ host: 'h', port: 1 }],
      sentinelUser: 'u',
    });
    expect(keys(parsed)).toEqual(keys(redis.properties));
    expect(redis.properties?.mode?.enum).toEqual([...REDIS_MODES]);
    expect(redis.properties?.nodes?.maxItems).toBe(MAX_REDIS_NODES);
    expect(keys(redis.properties?.nodes?.items?.properties)).toEqual(['host', 'port']);
    expect(redis.additionalProperties).toBe(false);
    expect(redis.required).toEqual(['mode']);
  });
});
