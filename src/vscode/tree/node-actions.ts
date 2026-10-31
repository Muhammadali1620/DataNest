// What a tree item can do, as a list of commands (V11.12): the "actions" button on an
// item opens it, because the right-click menu cannot be opened from a button. Only ids
// here; the texts and icons come from the manifest and `node-actions-ui.ts`. A test keeps
// the list in line with the manifest's menus.

import { COMMAND_IDS } from '../command-ids';
import type { NodeSqlTarget } from '../../services/node-sql';
import type { TreeNode } from './nodes';

type Command = (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS];

/** What `readNodeSql` writes SQL for; undefined for nodes without such SQL. */
export function nodeSqlTargetOf(node: TreeNode): NodeSqlTarget | undefined {
  switch (node.kind) {
    case 'column':
      return { kind: 'column', table: node.table, column: node.column };
    case 'index':
      return { kind: 'index', table: node.table, index: node.index };
    case 'foreignKey':
      return { kind: 'foreignKey', table: node.table, key: node.key };
    case 'object':
      return { kind: 'object', object: node.object };
    case 'connection':
    case 'connectionFolder':
    case 'database':
    case 'elasticField':
    case 'elasticIndex':
    case 'folder':
    case 'group':
    case 'message':
    case 'mongoCollection':
    case 'mongoDatabase':
    case 'mongoIndex':
    case 'project':
    case 'queryFolder':
    case 'redisDatabase':
    case 'redisFolder':
    case 'redisKey':
    case 'redisMore':
    case 'schema':
    case 'security':
    case 'securityGroup':
    case 'table':
    case 'savedQuery':
    case 'account':
      return undefined;
  }
}

/** The commands of a node's actions list, most used first. */
export function actionsOf(node: TreeNode): readonly Command[] {
  switch (node.kind) {
    case 'table':
      return node.tableKind === 'table'
        ? [
            COMMAND_IDS.openTable,
            COMMAND_IDS.designTable,
            COMMAND_IDS.showDefinition,
            COMMAND_IDS.generateSelect,
            COMMAND_IDS.showErDiagram,
            COMMAND_IDS.renameTable,
            COMMAND_IDS.duplicateTable,
            COMMAND_IDS.copyName,
            COMMAND_IDS.refreshTree,
            COMMAND_IDS.truncateTable,
            COMMAND_IDS.dropTable,
          ]
        : [
            COMMAND_IDS.openTable,
            COMMAND_IDS.showDefinition,
            COMMAND_IDS.generateSelect,
            COMMAND_IDS.renameTable,
            COMMAND_IDS.copyName,
            COMMAND_IDS.refreshTree,
            COMMAND_IDS.dropTable,
          ];
    case 'column':
      return [
        COMMAND_IDS.openNodeSql,
        ...(node.movable === true ? [COMMAND_IDS.moveColumnUp, COMMAND_IDS.moveColumnDown] : []),
        COMMAND_IDS.copyName,
        COMMAND_IDS.refreshTree,
      ];
    case 'index':
    case 'foreignKey':
      return [COMMAND_IDS.openNodeSql, COMMAND_IDS.copyName];
    case 'object':
      return [
        // A trigger opens as the statement that replaces it; the others as their definition.
        node.object.kind === 'trigger' ? COMMAND_IDS.openNodeSql : COMMAND_IDS.showDefinition,
        ...(node.object.kind === 'sequence' ? [] : [COMMAND_IDS.editObject]),
        COMMAND_IDS.copyName,
        COMMAND_IDS.dropObject,
      ];
    case 'savedQuery':
      return [
        COMMAND_IDS.openSavedQuery,
        COMMAND_IDS.renameSavedQuery,
        COMMAND_IDS.copyName,
        COMMAND_IDS.deleteSavedQuery,
      ];
    case 'account':
      return [COMMAND_IDS.openAccount, COMMAND_IDS.copyName];
    case 'connection':
    case 'connectionFolder':
    case 'database':
    case 'elasticField':
    case 'elasticIndex':
    case 'folder':
    case 'group':
    case 'message':
    case 'mongoCollection':
    case 'mongoDatabase':
    case 'mongoIndex':
    case 'project':
    case 'queryFolder':
    case 'redisDatabase':
    case 'redisFolder':
    case 'redisKey':
    case 'redisMore':
    case 'schema':
    case 'security':
    case 'securityGroup':
      return [];
  }
}
