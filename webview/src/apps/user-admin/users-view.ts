// How the users and privileges page (V8.6) names accounts and grants, filters them,
// and builds the changes it asks the host to preview and run.

import type {
  AdminChange,
  AdminGrant,
  AdminLevel,
  AdminUser,
  UserAdminState,
} from '../../../../src/shared/protocols/user-admin';

export type Features = NonNullable<UserAdminState['features']>;

/** One account by name and host, for `#each` keys and the chosen one. */
export function userKey(user: Pick<AdminUser, 'name' | 'host'>): string {
  return `${user.name}\u0000${user.host ?? ''}`;
}

/** `app@%` where accounts have hosts, `app` elsewhere. */
export function userLabel(user: Pick<AdminUser, 'name' | 'host'>): string {
  return user.host === undefined ? user.name : `${user.name}@${user.host}`;
}

export function filterUsers(users: readonly AdminUser[], text: string): AdminUser[] {
  const needle = text.trim().toLowerCase();
  return needle === ''
    ? [...users]
    : users.filter((user) =>
        [userLabel(user), ...user.flags, ...user.memberOf].some((part) =>
          part.toLowerCase().includes(needle),
        ),
      );
}

const ORDER: readonly AdminLevel[] = [
  'server',
  'database',
  'schema',
  'allTables',
  'table',
  'sequence',
  'routine',
  'role',
];

/** What a grant applies to, written as people write it: `shop.*`, `public.orders`. */
export function targetLabel(grant: Omit<AdminGrant, 'privilege' | 'grantable'>): string {
  const qualified = (first: string | undefined, second: string | undefined): string =>
    [first, second].filter((part) => part !== undefined && part !== '').join('.');
  switch (grant.level) {
    case 'server':
      return '*';
    case 'database':
      return grant.database ?? '';
    case 'schema':
      return grant.schema ?? '';
    case 'allTables':
      return `${grant.schema ?? ''}.*`;
    case 'table':
    case 'sequence':
    case 'routine':
      return qualified(grant.schema ?? grant.database, grant.name);
    case 'role':
      return grant.host === undefined ? (grant.name ?? '') : `${grant.name ?? ''}@${grant.host}`;
  }
}

/** Grants by level, then object, then privilege, so one object's rows stay together. */
export function sortGrants(grants: readonly AdminGrant[]): AdminGrant[] {
  return [...grants].sort(
    (a, b) =>
      ORDER.indexOf(a.level) - ORDER.indexOf(b.level) ||
      targetLabel(a).localeCompare(targetLabel(b)) ||
      a.privilege.localeCompare(b.privilege),
  );
}

export type TargetField = 'database' | 'schema' | 'name' | 'role' | 'host';

/** The fields the grant form asks for at a level. */
export function targetFields(level: AdminLevel, features: Features): TargetField[] {
  switch (level) {
    case 'server':
      return [];
    case 'database':
      return ['database'];
    case 'schema':
    case 'allTables':
      return ['schema'];
    case 'table':
    case 'sequence':
    case 'routine':
      return [features.tablesIn, 'name'];
    case 'role':
      return features.hosts ? ['role', 'host'] : ['role'];
  }
}

/** What the grant form holds; the page edits it in place. */
export interface GrantForm {
  level: AdminLevel;
  database: string;
  schema: string;
  name: string;
  role: string;
  host: string;
  privileges: readonly string[];
  grantable: boolean;
}

/** The grant the form describes, with only the fields its level uses. */
export function grantChange(
  user: Pick<AdminUser, 'name' | 'host'>,
  form: GrantForm,
  features: Features,
): AdminChange {
  const fields = targetFields(form.level, features);
  const value = (field: TargetField): string =>
    field === 'role' ? form.role.trim() : form[field].trim();
  return {
    kind: 'grant',
    user: ref(user),
    target: {
      level: form.level,
      ...(fields.includes('database') ? { database: value('database') } : {}),
      ...(fields.includes('schema') ? { schema: value('schema') } : {}),
      ...(fields.includes('name') ? { name: value('name') } : {}),
      ...(fields.includes('role') ? { name: value('role') } : {}),
      ...(fields.includes('host') && value('host') !== '' ? { host: value('host') } : {}),
    },
    privileges: form.level === 'role' ? [] : [...form.privileges],
    grantable: form.grantable,
  };
}

/** Taking back exactly one grant the server listed. */
export function revokeChange(
  user: Pick<AdminUser, 'name' | 'host'>,
  grant: AdminGrant,
): AdminChange {
  return {
    kind: 'revoke',
    user: ref(user),
    target: {
      level: grant.level,
      ...(grant.database === undefined ? {} : { database: grant.database }),
      ...(grant.schema === undefined ? {} : { schema: grant.schema }),
      ...(grant.name === undefined ? {} : { name: grant.name }),
      ...(grant.host === undefined ? {} : { host: grant.host }),
    },
    privileges: grant.level === 'role' ? [] : [grant.privilege],
    grantable: grant.grantable,
  };
}

export function ref(user: Pick<AdminUser, 'name' | 'host'>): AdminChange['user'] {
  return user.host === undefined ? { name: user.name } : { name: user.name, host: user.host };
}

/** The privileges of a level the form offers; an unknown level offers none. */
export function privilegesOf(features: Features, level: AdminLevel): readonly string[] {
  return features.levels.find((entry) => entry.level === level)?.privileges ?? [];
}

/** The form is complete enough to preview. */
export function grantReady(form: GrantForm, features: Features): boolean {
  const fields = targetFields(form.level, features).filter((field) => field !== 'host');
  const filled = fields.every((field) =>
    field === 'role' ? form.role.trim() !== '' : form[field].trim() !== '',
  );
  return filled && (form.level === 'role' || form.privileges.length > 0);
}
