// What the table designer panel does, without `vscode`: the state it sends, the
// preview it builds and how a save goes, for a new table and for an existing one.
// The panel only wires this to a webview.

import { errorMessage } from '../../core/errors';
import type {
  CheckConstraint,
  ObjectRef,
  ObjectScope,
  TableRef,
  TableStructure,
} from '../../core/model/objects';
import type { AlterNote, Driver, MetadataReader } from '../../drivers/driver';
import type {
  DesignPreview,
  SaveOutcome,
  TableDesignerState,
  TableTab,
} from '../../shared/protocols/table-designer';
import { designProblems, newTableDesign, type TableDesign } from '../../shared/table-design';
import { actionScript, actionSql, type SchemaAction } from '../../services/schema-actions';
import {
  checkPlanFor,
  checksSupported,
  triggerRef,
  triggersSupported,
  triggerTemplate,
} from '../../services/table-checks';
import { designFromStructure, type LoadedTable } from '../../services/table-structure';
import type { PerformOutcome } from '../tree/schema-commands';

export interface TableDesignerTexts {
  createTable(name: string): string;
  readonly create: string;
  alterTable(name: string): string;
  readonly apply: string;
  dropObject(name: string): string;
  readonly drop: string;
}

export type ActionOutcome = 'ran' | 'opened' | 'cancelled' | 'unsupported';

export interface TableDesignerModelDeps {
  readonly connectionId: string;
  readonly scope: ObjectScope;
  /** The table to edit; absent when designing a new one. */
  readonly table?: string;
  readonly driver: Pick<Driver, 'id' | 'dialect'>;
  readonly texts: TableDesignerTexts;
  /** The structure of the table's scope, read through the metadata cache. */
  readonly metadata: () => Promise<
    Pick<
      MetadataReader,
      'listTables' | 'listColumns' | 'describeTable' | 'listObjects' | 'getDefinition'
    >
  >;
  /** Opens SQL in a new editor on the table's connection and database. */
  readonly openSql: (sql: string) => Promise<void>;
  readonly copyText: (text: string) => Promise<void>;
  /** Opens the definition of an object in an editor whose "Apply" replaces the object. */
  readonly editObject: (object: ObjectRef) => Promise<void>;
  /** The tab to show first. */
  readonly tab?: TableTab;
  readonly perform: (
    connectionId: string,
    action: SchemaAction,
    title: string,
    runLabel: string,
  ) => Promise<PerformOutcome>;
}

export class TableDesignerModel {
  /** The table being edited as it is now; undefined while designing a new one. */
  private table: string | undefined;
  private loaded: LoadedTable | undefined;
  private checkList: readonly CheckConstraint[] = [];
  /** As last read: SQLite changes a check from the table's own CREATE text. */
  private structure: TableStructure | undefined;

  constructor(private readonly deps: TableDesignerModelDeps) {
    this.table = deps.table;
  }

  /** `shop`, `shop.public`, or nothing for a file database. */
  get scopeLabel(): string {
    const { database, schema } = this.deps.scope;
    return [database, schema].filter((part) => part !== undefined).join('.');
  }

  /** The name of the edited table, for the panel title; undefined for a new one. */
  get tableName(): string | undefined {
    return this.table;
  }

  async state(): Promise<TableDesignerState> {
    const { driver } = this.deps;
    const { designer } = driver.dialect.ddl;
    const features = {
      columnComments: designer.columnComments,
      tableComment: designer.tableComment,
      types: [...designer.types],
      reorder: designer.reorder,
      autoIncrement: designer.autoIncrement,
      foreignKeys: designer.foreignKeys,
      uniqueIndexes: designer.uniqueIndexes,
      triggers: this.table !== undefined && triggersSupported(driver.id),
      checks: this.table !== undefined && checksSupported(driver.id),
    };
    if (this.table === undefined) {
      return {
        mode: 'create',
        driver: driver.id,
        scope: this.scopeLabel,
        features,
        ...(this.deps.tab === undefined ? {} : { tab: this.deps.tab }),
        design: newTableDesign(driver.id),
        kept: { indexes: [], columns: [] },
      };
    }
    const loaded = await this.load(this.table);
    return {
      mode: 'edit',
      driver: driver.id,
      scope: this.scopeLabel,
      features,
      ...(this.deps.tab === undefined ? {} : { tab: this.deps.tab }),
      design: loaded.design,
      kept: {
        indexes: loaded.background.fixedIndexes.map((index) => ({ ...index })),
        columns: [...loaded.background.generatedColumns],
      },
    };
  }

  /** The CREATE statements of the stored table, as a script. */
  async definition(): Promise<{ text: string }> {
    const metadata = await this.deps.metadata();
    const statements = await metadata.getDefinition({ ...this.ref(), kind: 'table' });
    return { text: actionScript(statements) };
  }

  /** Triggers that belong to the stored table. */
  async triggers(): Promise<{ triggers: string[] }> {
    const metadata = await this.deps.metadata();
    const found = await metadata.listObjects(this.deps.scope, 'trigger');
    return {
      triggers: found.filter((object) => object.table === this.table).map((object) => object.name),
    };
  }

  async triggerAction(
    action: 'view' | 'edit' | 'drop' | 'new',
    name: string | undefined,
  ): Promise<{ outcome: ActionOutcome }> {
    const table = this.ref();
    const { driver, texts } = this.deps;
    if (action === 'new') {
      await this.deps.openSql(triggerTemplate(driver.id, driver.dialect, table));
      return { outcome: 'opened' };
    }
    if (name === undefined) {
      return { outcome: 'unsupported' };
    }
    const object = triggerRef(table, name);
    if (action === 'view') {
      const metadata = await this.deps.metadata();
      await this.deps.openSql(actionScript(await metadata.getDefinition(object)));
      return { outcome: 'opened' };
    }
    if (action === 'edit') {
      await this.deps.editObject(object);
      return { outcome: 'opened' };
    }
    const outcome = await this.deps.perform(
      this.deps.connectionId,
      { kind: 'dropObject', object },
      texts.dropObject(name),
      texts.drop,
    );
    return { outcome: outcome === 'refused' ? 'cancelled' : outcome };
  }

  /** CHECK constraints of the stored table, read afresh. */
  async checks(): Promise<{ checks: CheckConstraint[] }> {
    if (this.table !== undefined) {
      await this.load(this.table);
    }
    return { checks: [...this.checkList] };
  }

  async checkAction(
    action: 'add' | 'drop',
    name: string,
    expression: string | undefined,
  ): Promise<{ outcome: ActionOutcome; error?: string }> {
    const { driver, texts } = this.deps;
    const table = this.ref();
    if (this.table !== undefined && driver.dialect.ddl.changeCheck !== undefined) {
      // A rebuild starts from the stored CREATE text: it must be what is there now.
      await this.load(this.table);
    }
    let plan: { statements: string[]; recovery: string[] };
    try {
      plan = checkPlanFor(driver.dialect, table, this.structure, {
        action,
        name,
        ...(expression === undefined ? {} : { expression }),
      });
    } catch (error) {
      return { outcome: 'unsupported', error: errorMessage(error) };
    }
    const outcome = await this.deps.perform(
      this.deps.connectionId,
      {
        kind: 'runStatements',
        scope: this.deps.scope,
        statements: plan.statements,
        ...(plan.recovery.length === 0 ? {} : { recovery: plan.recovery }),
      },
      texts.alterTable(table.name),
      texts.apply,
    );
    if (outcome === 'ran') {
      this.loaded = undefined;
    }
    return { outcome: outcome === 'refused' ? 'cancelled' : outcome };
  }

  async textAction(action: 'copy' | 'open', text: string): Promise<void> {
    await (action === 'copy' ? this.deps.copyText(text) : this.deps.openSql(text));
  }

  /** The SQL of a design; nothing while it has problems or changes nothing. */
  preview(design: TableDesign): DesignPreview {
    if (designProblems(design, this.deps.driver.id).length > 0) {
      return { statements: [], notes: [] };
    }
    try {
      if (this.loaded !== undefined) {
        const plan = this.plan(design);
        return { statements: [...plan.statements], notes: [...plan.notes] };
      }
      return {
        statements: actionSql(this.action(design), this.deps.driver.dialect.ddl),
        notes: [],
      };
    } catch (error) {
      return { statements: [], notes: [], error: errorMessage(error) };
    }
  }

  /** Tables of the scope a foreign key may point at, by name. */
  async tables(): Promise<{ tables: string[] }> {
    const metadata = await this.deps.metadata();
    const tables = await metadata.listTables(this.deps.scope);
    return { tables: tables.filter((table) => table.kind === 'table').map((table) => table.name) };
  }

  /** Columns of one table of the scope, for the referenced side of a key. */
  async columns(table: string): Promise<{ columns: string[] }> {
    const metadata = await this.deps.metadata();
    const columns = await metadata.listColumns({ ...this.deps.scope, name: table });
    return { columns: columns.map((column) => column.name) };
  }

  /**
   * Shows the SQL and runs it if the user agrees. After a successful run the model
   * holds the table as it now is, so the next save starts from there.
   */
  async save(design: TableDesign): Promise<SaveOutcome> {
    // The page checks the same rules, but the page is not trusted (§5).
    if (designProblems(design, this.deps.driver.id).length > 0) {
      return { outcome: 'invalid' };
    }
    if (this.loaded !== undefined && this.plan(design).statements.length === 0) {
      return { outcome: 'unchanged' };
    }
    const { texts } = this.deps;
    const name = design.name.trim();
    const outcome = await this.deps.perform(
      this.deps.connectionId,
      this.action(design),
      this.loaded === undefined ? texts.createTable(name) : texts.alterTable(this.table ?? name),
      this.loaded === undefined ? texts.create : texts.apply,
    );
    if (outcome === 'ran') {
      this.table = name;
      this.loaded = undefined;
    }
    // A read-only connection already said why; for the page nothing happened.
    return { outcome: outcome === 'refused' ? 'cancelled' : outcome };
  }

  private plan(design: TableDesign): {
    statements: readonly string[];
    notes: readonly AlterNote[];
  } {
    const loaded = this.loaded;
    if (loaded === undefined) {
      return { statements: [], notes: [] };
    }
    return this.deps.driver.dialect.ddl.alterTable(
      this.ref(),
      loaded.design,
      design,
      loaded.background,
    );
  }

  private ref(): TableRef {
    return { ...this.deps.scope, name: this.table ?? '' };
  }

  private action(design: TableDesign): SchemaAction {
    if (this.loaded !== undefined) {
      return {
        kind: 'alterTable',
        table: this.ref(),
        before: this.loaded.design,
        after: design,
        background: this.loaded.background,
      };
    }
    return {
      kind: 'createTable',
      table: { ...this.deps.scope, name: design.name.trim() },
      design,
    };
  }

  private async load(table: string): Promise<LoadedTable> {
    const metadata = await this.deps.metadata();
    const ref = { ...this.deps.scope, name: table };
    const structure = await metadata.describeTable(ref);
    this.checkList = structure.checks ?? [];
    this.structure = structure;
    this.loaded = designFromStructure(ref, structure);
    return this.loaded;
  }
}
