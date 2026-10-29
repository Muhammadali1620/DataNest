// What Elasticsearch nodes of the tree contain (V7.8): a connection's indices, an index's
// mapping fields, and the fields inside an object, a nested field or a multi-field. Free
// of `vscode`, like TreeModel, which hands these nodes over.

import type { ElasticSession } from '../../drivers/elastic-driver';
import { ConnectionManager } from '../../services/connection-manager';
import { listFields, listIndices } from '../../services/elasticsearch/catalog';
import type { ElasticFieldNode, ElasticIndexNode, TreeNode } from './nodes';

export interface ElasticTreeDeps {
  readonly manager: Pick<ConnectionManager, 'acquireElastic'>;
  readonly showSystemObjects: () => boolean;
  readonly texts: { readonly noIndices: string; readonly noFields: string };
}

/** The tree's session of an Elasticsearch connection. */
export async function elasticTreeSession(
  manager: Pick<ConnectionManager, 'acquireElastic'>,
  connectionId: string,
): Promise<ElasticSession> {
  return await manager.acquireElastic(ConnectionManager.treeOwner(connectionId), { connectionId });
}

export async function elasticIndexChildren(
  deps: ElasticTreeDeps,
  connectionId: string,
): Promise<TreeNode[]> {
  const session = await elasticTreeSession(deps.manager, connectionId);
  const indices = await listIndices(session, deps.showSystemObjects());
  return indices.length === 0
    ? [{ kind: 'message', text: deps.texts.noIndices, connectionId }]
    : indices.map((index): ElasticIndexNode => ({ kind: 'elasticIndex', connectionId, index }));
}

export async function elasticFieldChildren(
  deps: ElasticTreeDeps,
  node: ElasticIndexNode,
): Promise<TreeNode[]> {
  const session = await elasticTreeSession(deps.manager, node.connectionId);
  const fields = await listFields(session, node.index.name);
  return fields.length === 0
    ? [{ kind: 'message', text: deps.texts.noFields, connectionId: node.connectionId }]
    : fields.map((field): ElasticFieldNode => ({
        kind: 'elasticField',
        connectionId: node.connectionId,
        index: node.index.name,
        field,
      }));
}

/** The fields inside a field come with it: no request. */
export function elasticSubfields(node: ElasticFieldNode): TreeNode[] {
  return node.field.children.map((field): ElasticFieldNode => ({
    kind: 'elasticField',
    connectionId: node.connectionId,
    index: node.index,
    field,
  }));
}
