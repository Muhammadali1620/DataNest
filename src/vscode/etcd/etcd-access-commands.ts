// "Users and Roles" of an etcd connection (V13.27), free of `vscode`: one command that
// walks the user through the users, the roles and the permissions of a cluster with
// pickers and input boxes. What the dialogs ask comes in through `EtcdAccessUi`, so every
// path (a refused change, a production connection, backing out) is tested without an
// editor. Looking is always allowed; every change needs a connection that is not read-only,
// and a production one asks first.

import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import type { ConnectionStore } from '../../services/connection-store';
import {
  addRole,
  addUser,
  boundsOf,
  changePassword,
  deleteRole,
  deleteUser,
  type EtcdPermission,
  grantPermission,
  grantRole,
  listRoles,
  listUsers,
  nameProblem,
  type PermissionScope,
  permissionText,
  type PermissionType,
  revokePermission,
  revokeRole,
  roleView,
  ROOT_ROLE,
  userRoles,
} from '../../services/etcd/etcd-auth';
import type { EtcdCaller } from '../../services/etcd/etcd-client';
import { changeVerdict, policyOf } from '../../services/write-policy';
import { connectionIdOf } from '../tree/nodes';
import type { CommandTarget } from '../tree/tree-commands';
import type { EtcdCommandUi } from './etcd-commands';

export interface AccessPickItem<T> {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  /** Codicon name, without the `$(…)`. */
  readonly icon?: string;
  readonly value: T;
}

export interface EtcdAccessUi extends EtcdCommandUi {
  /** Lets the user pick one item; undefined when they back out. */
  pick<T>(options: {
    readonly title: string;
    readonly placeHolder?: string;
    readonly items: readonly AccessPickItem<T>[];
  }): Promise<T | undefined>;
}

export interface EtcdAccessDeps {
  readonly store: Pick<ConnectionStore, 'get' | 'list'>;
  /** The tree's session of a connection. */
  readonly session: (connectionId: string) => Promise<EtcdCaller>;
  readonly ui: EtcdAccessUi;
  readonly texts: {
    readonly noEtcd: string;
    readonly readOnly: string;
  };
}

type Choice =
  | { readonly to: 'addUser' }
  | { readonly to: 'addRole' }
  | { readonly to: 'user'; readonly name: string }
  | { readonly to: 'role'; readonly name: string };

const PERMISSION_TYPES: readonly { type: PermissionType; label: () => string }[] = [
  { type: 'read', label: () => msg('Read') },
  { type: 'write', label: () => msg('Write') },
  { type: 'readwrite', label: () => msg('Read and write') },
];

export function etcdAccessHandler(
  deps: EtcdAccessDeps,
): (target?: CommandTarget) => Promise<undefined> {
  const { ui } = deps;

  const connectionOf = async (target: CommandTarget): Promise<string | undefined> => {
    const given = connectionIdOf(target);
    if (given !== undefined) {
      if (deps.store.get(given)?.driver !== 'etcd') {
        throw new DbError('unsupported', deps.texts.noEtcd);
      }
      return given;
    }
    const all = deps.store.list().filter((config) => config.driver === 'etcd');
    if (all.length === 0) {
      throw new DbError('not-found', deps.texts.noEtcd);
    }
    return all.length === 1 ? all[0]?.id : await ui.pickConnection(all.map((config) => config.id));
  };

  /** A change: refused on a read-only connection, asked about on a production one. */
  const allowChange = async (connectionId: string, what: string): Promise<boolean> => {
    const policy = policyOf(deps.store.get(connectionId));
    const verdict = changeVerdict(policy);
    if (verdict === 'refuse') {
      throw new DbError('permission-denied', deps.texts.readOnly);
    }
    return verdict === 'confirm'
      ? await ui.confirm(
          msg('Change access on the production connection "{0}"?', policy.name),
          what,
          msg('Change'),
        )
      : true;
  };

  const askName = async (title: string, prompt: string): Promise<string | undefined> =>
    await ui.input({
      title,
      prompt,
      validate: (value) => {
        const problem = nameProblem(value);
        return problem === undefined
          ? undefined
          : problem === 'empty'
            ? msg('A name is needed')
            : msg('A name has up to 256 characters');
      },
    });

  const askPassword = async (title: string, name: string): Promise<string | undefined> =>
    await ui.input({
      title,
      prompt: msg('The password of the user "{0}"', name),
      password: true,
      validate: (value) => (value === '' ? msg('A password is needed') : undefined),
    });

  const addUserFlow = async (connectionId: string, session: EtcdCaller): Promise<void> => {
    const name = await askName(msg('Add User'), msg('The name of the new user'));
    if (name === undefined) {
      return;
    }
    const password = await askPassword(msg('Add User'), name);
    if (password === undefined || !(await allowChange(connectionId, name))) {
      return;
    }
    await addUser(session, name, password);
    ui.info(msg('The user "{0}" was added', name));
  };

  const addRoleFlow = async (connectionId: string, session: EtcdCaller): Promise<void> => {
    const name = await askName(msg('Add Role'), msg('The name of the new role'));
    if (name === undefined || !(await allowChange(connectionId, name))) {
      return;
    }
    await addRole(session, name);
    ui.info(msg('The role "{0}" was added', name));
  };

  const userFlow = async (
    connectionId: string,
    session: EtcdCaller,
    name: string,
  ): Promise<void> => {
    for (;;) {
      const roles = await userRoles(session, name);
      const action = await ui.pick<'grant' | 'revoke' | 'password' | 'delete'>({
        title: msg('User "{0}"', name),
        placeHolder: roles.length === 0 ? msg('No roles') : msg('Roles: {0}', roles.join(', ')),
        items: [
          { label: msg('Grant a Role…'), icon: 'add', value: 'grant' },
          ...(roles.length === 0
            ? []
            : [{ label: msg('Revoke a Role…'), icon: 'remove', value: 'revoke' as const }]),
          { label: msg('Change the Password…'), icon: 'key', value: 'password' },
          { label: msg('Delete the User'), icon: 'trash', value: 'delete' },
        ],
      });
      if (action === undefined) {
        return;
      }
      if (action === 'grant') {
        const all = await listRoles(session);
        const free = all.filter((role) => !roles.includes(role));
        const role = await ui.pick({
          title: msg('Grant a role to "{0}"', name),
          placeHolder:
            free.length === 0 ? msg('Every role is granted already') : msg('Pick a role'),
          items: free.map((one) => ({ label: one, icon: 'organization', value: one })),
        });
        if (role !== undefined && (await allowChange(connectionId, `${name} ← ${role}`))) {
          await grantRole(session, name, role);
        }
      } else if (action === 'revoke') {
        const role = await ui.pick({
          title: msg('Revoke a role from "{0}"', name),
          items: roles.map((one) => ({ label: one, icon: 'organization', value: one })),
        });
        if (role !== undefined && (await allowChange(connectionId, `${name} ✕ ${role}`))) {
          await revokeRole(session, name, role);
        }
      } else if (action === 'password') {
        const password = await askPassword(msg('Change the Password'), name);
        if (password !== undefined && (await allowChange(connectionId, name))) {
          await changePassword(session, name, password);
          ui.info(msg('The password of "{0}" was changed', name));
        }
      } else {
        const detail = [
          roles.includes(ROOT_ROLE)
            ? msg('This user has the root role: it may be the only way to manage the cluster.')
            : undefined,
          msg('A user that is signed in keeps working until its token ends.'),
        ]
          .filter((line): line is string => line !== undefined)
          .join(' ');
        if (
          (await ui.confirm(msg('Delete the user "{0}"?', name), detail, msg('Delete'))) &&
          (await allowChange(connectionId, name))
        ) {
          await deleteUser(session, name);
          return;
        }
      }
    }
  };

  const askPermission = async (): Promise<EtcdPermission | undefined> => {
    const type = await ui.pick<PermissionType>({
      title: msg('Grant a Permission'),
      placeHolder: msg('What the role may do'),
      items: PERMISSION_TYPES.map((one) => ({
        label: one.label(),
        icon: one.type === 'read' ? 'eye' : one.type === 'write' ? 'edit' : 'arrow-swap',
        value: one.type,
      })),
    });
    if (type === undefined) {
      return undefined;
    }
    const scope = await ui.pick<PermissionScope>({
      title: msg('Grant a Permission'),
      placeHolder: msg('Which keys'),
      items: [
        { label: msg('Keys that start with…'), icon: 'folder', value: 'prefix' },
        { label: msg('One key'), icon: 'key', value: 'key' },
        { label: msg('A range of keys…'), icon: 'arrow-both', value: 'range' },
        { label: msg('All keys'), icon: 'globe', value: 'all' },
      ],
    });
    if (scope === undefined) {
      return undefined;
    }
    const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
    const needsKey = (value: string): string | undefined =>
      value === '' ? msg('A key is needed') : undefined;
    if (scope === 'all') {
      return { type, ...boundsOf('all', new Uint8Array()) };
    }
    const key = await ui.input({
      title: msg('Grant a Permission'),
      prompt:
        scope === 'prefix'
          ? msg('The beginning of the key names')
          : scope === 'range'
            ? msg('The first key of the range')
            : msg('The name of the key'),
      placeHolder: '/app/',
      validate: needsKey,
    });
    if (key === undefined) {
      return undefined;
    }
    let end: Uint8Array | undefined;
    if (scope === 'range') {
      const last = await ui.input({
        title: msg('Grant a Permission'),
        prompt: msg('The key after the last one of the range (it is not included)'),
        validate: needsKey,
      });
      if (last === undefined) {
        return undefined;
      }
      end = encode(last);
    }
    return { type, ...boundsOf(scope, encode(key), end) };
  };

  const roleFlow = async (
    connectionId: string,
    session: EtcdCaller,
    name: string,
  ): Promise<void> => {
    for (;;) {
      const view = await roleView(session, name);
      const action = await ui.pick<'grant' | 'revoke' | 'delete' | 'none'>({
        title: msg('Role "{0}"', name),
        placeHolder:
          view.permissions.length === 0
            ? msg('No permissions')
            : msg('{0} permissions', view.permissions.length),
        items: [
          ...view.permissions.map((permission) => ({
            label: permissionText(permission),
            icon: 'shield',
            value: 'none' as const,
          })),
          { label: msg('Grant a Permission…'), icon: 'add', value: 'grant' as const },
          ...(view.permissions.length === 0
            ? []
            : [{ label: msg('Revoke a Permission…'), icon: 'remove', value: 'revoke' as const }]),
          { label: msg('Delete the Role'), icon: 'trash', value: 'delete' as const },
        ],
      });
      if (action === undefined) {
        return;
      }
      if (action === 'grant') {
        const permission = await askPermission();
        if (
          permission !== undefined &&
          (await allowChange(connectionId, permissionText(permission)))
        ) {
          await grantPermission(session, name, permission);
        }
      } else if (action === 'revoke') {
        const permission = await ui.pick<EtcdPermission>({
          title: msg('Revoke a permission from "{0}"', name),
          items: view.permissions.map((one) => ({
            label: permissionText(one),
            icon: 'shield',
            value: one,
          })),
        });
        if (
          permission !== undefined &&
          (await allowChange(connectionId, permissionText(permission)))
        ) {
          await revokePermission(session, name, permission);
        }
      } else if (action === 'delete') {
        const detail =
          name === ROOT_ROLE
            ? msg('The root role lets a user manage the cluster; without it, nobody may.')
            : msg('Every user that has the role loses it.');
        if (
          (await ui.confirm(msg('Delete the role "{0}"?', name), detail, msg('Delete'))) &&
          (await allowChange(connectionId, name))
        ) {
          await deleteRole(session, name);
          return;
        }
      }
    }
  };

  return async (target?: CommandTarget) => {
    const connectionId = await connectionOf(target);
    if (connectionId === undefined) {
      return undefined;
    }
    const session = await deps.session(connectionId);
    for (;;) {
      const [users, roles] = await Promise.all([listUsers(session), listRoles(session)]);
      const choice = await ui.pick<Choice>({
        title: msg('Users and Roles'),
        placeHolder: msg('{0} users, {1} roles', users.length, roles.length),
        items: [
          { label: msg('Add a User…'), icon: 'person-add', value: { to: 'addUser' } },
          { label: msg('Add a Role…'), icon: 'add', value: { to: 'addRole' } },
          ...users.map((name) => ({
            label: name,
            description: msg('user'),
            icon: 'account',
            value: { to: 'user', name } as const,
          })),
          ...roles.map((name) => ({
            label: name,
            description: msg('role'),
            icon: 'organization',
            value: { to: 'role', name } as const,
          })),
        ],
      });
      if (choice === undefined) {
        return undefined;
      }
      switch (choice.to) {
        case 'addUser':
          await addUserFlow(connectionId, session);
          break;
        case 'addRole':
          await addRoleFlow(connectionId, session);
          break;
        case 'user':
          await userFlow(connectionId, session, choice.name);
          break;
        case 'role':
          await roleFlow(connectionId, session, choice.name);
          break;
      }
    }
  };
}
