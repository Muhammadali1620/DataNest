// What the query plan page (V8.2) shows, free of `vscode`: the statement, the last
// plan or why there is none, and whether a run is going on.

import { errorMessage, isDbError } from '../../core/errors';
import type { QueryPlanState } from '../../shared/protocols/query-plan';
import { metricBasis, planRows, type QueryPlan } from '../../shared/query-plan';

export interface ExplainAnswer {
  readonly plan: QueryPlan;
  /** The server can run this statement for real figures. */
  readonly canAnalyze: boolean;
}

export interface QueryPlanModelDeps {
  readonly connectionName: string;
  /** Explains a statement on the editor's session. */
  readonly explain: (statement: string, analyze: boolean) => Promise<ExplainAnswer>;
  /** Text for a cancelled run, in the user's language. */
  readonly cancelledText: string;
}

export class QueryPlanModel {
  private plan: QueryPlan | undefined;
  private error: string | undefined;
  private running = false;
  private canAnalyze = false;

  constructor(
    private readonly deps: QueryPlanModelDeps,
    private statement: string,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** A new statement drops the old plan, which belongs to another query. */
  setStatement(statement: string): void {
    if (statement !== this.statement) {
      this.statement = statement;
      this.plan = undefined;
    }
  }

  async run(analyze: boolean): Promise<void> {
    this.running = true;
    this.error = undefined;
    try {
      const answer = await this.deps.explain(this.statement, analyze);
      this.plan = answer.plan;
      this.canAnalyze = answer.canAnalyze;
    } catch (error) {
      this.error =
        isDbError(error) && error.code === 'cancelled'
          ? this.deps.cancelledText
          : errorMessage(error);
    } finally {
      this.running = false;
    }
  }

  state(): QueryPlanState {
    const plan = this.plan;
    return {
      statement: this.statement,
      connection: this.deps.connectionName,
      canAnalyze: this.canAnalyze,
      running: this.running,
      analyzed: plan?.analyzed ?? false,
      basis: plan === undefined ? 'none' : metricBasis(plan),
      rows: plan === undefined ? [] : planRows(plan),
      properties: plan === undefined ? [] : plan.properties.map(([key, value]) => [key, value]),
      notes: plan === undefined ? [] : [...plan.notes],
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  /** The server's own answer and the language to show it in. */
  raw(): { text: string; language: 'json' | 'xml' | 'plaintext' } | undefined {
    const text = this.plan?.raw;
    if (text === undefined || text === '') {
      return undefined;
    }
    const start = text.trimStart()[0];
    const language = start === '<' ? 'xml' : start === '{' || start === '[' ? 'json' : 'plaintext';
    return { text, language };
  }
}
