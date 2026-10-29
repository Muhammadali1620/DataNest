// Commands on the indices of an Elasticsearch cluster from the tree (V7.8): a new index
// with its settings and mappings, a deleted one (its name typed back). The editor bits
// arrive through the deps, so the behaviour is covered by unit tests.

import { DbError } from '../../core/errors';
import type { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import { createIndex, deleteIndex, indexNameProblem } from '../../services/elasticsearch/catalog';
import { isTreeNode } from '../tree/nodes';
import type { CommandTarget, RefreshableTree } from '../tree/tree-commands';
import { elasticTreeSession } from '../tree/elastic-tree';
import type { TextQuestion } from '../mongodb/mongo-tree-commands';

export interface ElasticTreeTexts {
  readonly newIndex: string;
  readonly indexName: string;
  readonly indexBody: string;
  deleteIndex(name: string): string;
  typeToDelete(name: string): string;
  readonly typeExactly: string;
  readonly deleteAction: string;
  productionDetail(connection: string): string;
  readonly changeAction: string;
  readonly readOnly: string;
  readonly noElastic: string;
}

export interface ElasticTreeCommandDeps {
  readonly manager: Pick<ConnectionManager, 'acquireElastic'>;
  readonly store: Pick<ConnectionStore, 'get' | 'list'>;
  readonly tree: RefreshableTree;
  readonly pickConnection: (ids: readonly string[]) => Promise<string | undefined>;
  readonly askText: (question: TextQuestion) => Promise<string | undefined>;
  readonly confirm: (
    message: string,
    detail: string | undefined,
    action: string,
  ) => Promise<boolean>;
  readonly texts: ElasticTreeTexts;
}

export function elasticTreeCommandHandlers(
  deps: ElasticTreeCommandDeps,
): Record<'newIndex' | 'deleteIndex', (target?: CommandTarget) => Promise<undefined>> {
  const { texts } = deps;

  const connectionOf = async (target: CommandTarget): Promise<string | undefined> => {
    const id = isTreeNode(target)
      ? 'connectionId' in target
        ? target.connectionId
        : undefined
      : target;
    if (id !== undefined && id !== '') {
      if (deps.store.get(id)?.driver !== 'elasticsearch') {
        throw new DbError('unsupported', texts.noElastic);
      }
      return id;
    }
    const elastic = deps.store.list().filter((config) => config.driver === 'elasticsearch');
    if (elastic.length === 0) {
      throw new DbError('not-found', texts.noElastic);
    }
    return await deps.pickConnection(elastic.map((config) => config.id));
  };

  const refuseReadOnly = (connectionId: string): void => {
    if (deps.store.get(connectionId)?.readOnly === true) {
      throw new DbError('permission-denied', texts.readOnly);
    }
  };

  return {
    newIndex: async (target) => {
      const connectionId = await connectionOf(target);
      if (connectionId === undefined) {
        return undefined;
      }
      refuseReadOnly(connectionId);
      const name = await deps.askText({
        title: texts.newIndex,
        prompt: texts.indexName,
        check: indexNameProblem,
      });
      if (name === undefined) {
        return undefined;
      }
      const body = await deps.askText({
        title: texts.newIndex,
        prompt: texts.indexBody,
        placeHolder: '{ "mappings": { "properties": { "name": { "type": "text" } } } }',
      });
      if (body === undefined) {
        return undefined;
      }
      const config = deps.store.get(connectionId);
      if (
        config?.production === true &&
        !(await deps.confirm(texts.productionDetail(config.name), undefined, texts.changeAction))
      ) {
        return undefined;
      }
      await createIndex(await elasticTreeSession(deps.manager, connectionId), name, body);
      deps.tree.refresh({ kind: 'connection', connectionId });
      return undefined;
    },

    deleteIndex: async (target) => {
      if (!isTreeNode(target) || target.kind !== 'elasticIndex') {
        return undefined;
      }
      const { connectionId } = target;
      const name = target.index.name;
      refuseReadOnly(connectionId);
      const config = deps.store.get(connectionId);
      const detail = config?.production === true ? texts.productionDetail(config.name) : undefined;
      if (!(await deps.confirm(texts.deleteIndex(name), detail, texts.deleteAction))) {
        return undefined;
      }
      // An index goes only when its name is typed back (D43).
      const typed = await deps.askText({
        title: texts.deleteIndex(name),
        prompt: texts.typeToDelete(name),
        check: (text) => (text === name ? undefined : texts.typeExactly),
      });
      if (typed !== name) {
        return undefined;
      }
      await deleteIndex(await elasticTreeSession(deps.manager, connectionId), name);
      deps.tree.refresh({ kind: 'connection', connectionId });
      return undefined;
    },
  };
}
