// What the table designer panel does, without `vscode`: the state it sends, the
// preview it builds and how a save goes. The panel only wires this to a webview.

import { errorMessage } from '../../core/errors';
import type { ObjectScope } from '../../core/model/objects';
import type { Driver } from '../../drivers/driver';
import type {
  TableDesignerState,
  DesignPreview,
  SaveOutcome,
} from '../../shared/protocols/table-designer';
import { designProblems, newTableDesign, type TableDesign } from '../../shared/table-design';
import { actionSql, type SchemaAction } from '../../services/schema-actions';
import type { PerformOutcome } from '../tree/schema-commands';

export interface TableDesignerTexts {
  createTable(name: string): string;
  readonly create: string;
}

export interface TableDesignerModelDeps {
  readonly connectionId: string;
  readonly scope: ObjectScope;
  readonly driver: Pick<Driver, 'id' | 'dialect'>;
  readonly texts: TableDesignerTexts;
  readonly perform: (
    connectionId: string,
    action: SchemaAction,
    title: string,
    runLabel: string,
  ) => Promise<PerformOutcome>;
}

export class TableDesignerModel {
  constructor(private readonly deps: TableDesignerModelDeps) {}

  /** `shop`, `shop.public`, or nothing for a file database. */
  get scopeLabel(): string {
    const { database, schema } = this.deps.scope;
    return [database, schema].filter((part) => part !== undefined).join('.');
  }

  state(): TableDesignerState {
    const { driver } = this.deps;
    const { designer } = driver.dialect.ddl;
    return {
      mode: 'create',
      driver: driver.id,
      scope: this.scopeLabel,
      features: {
        columnComments: designer.columnComments,
        tableComment: designer.tableComment,
        types: [...designer.types],
      },
      design: newTableDesign(driver.id),
    };
  }

  /** The SQL of a design; nothing while the design still has problems. */
  preview(design: TableDesign): DesignPreview {
    if (designProblems(design, this.deps.driver.id).length > 0) {
      return { statements: [] };
    }
    try {
      return { statements: actionSql(this.action(design), this.deps.driver.dialect.ddl) };
    } catch (error) {
      return { statements: [], error: errorMessage(error) };
    }
  }

  async save(design: TableDesign): Promise<SaveOutcome> {
    // The page checks the same rules, but the page is not trusted (§5).
    if (designProblems(design, this.deps.driver.id).length > 0) {
      return { outcome: 'invalid' };
    }
    const { texts } = this.deps;
    const outcome = await this.deps.perform(
      this.deps.connectionId,
      this.action(design),
      texts.createTable(design.name.trim()),
      texts.create,
    );
    return { outcome };
  }

  private action(design: TableDesign): SchemaAction {
    return { kind: 'createTable', table: { ...this.deps.scope, name: design.name.trim() }, design };
  }
}
