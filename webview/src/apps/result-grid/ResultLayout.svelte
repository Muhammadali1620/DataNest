<script lang="ts">
  import { cellText } from '../../../../src/shared/cell-text';
  import type { CellValue } from '../../../../src/shared/cell-value';
  import type { Translate } from '../../lib/i18n';
  import { LAYOUT_ROWS, rowsToJson, transpose } from './layouts';

  interface Props {
    mode: 'json' | 'transposed';
    columns: readonly { readonly name: string }[];
    rowCount: number;
    /** A row that has arrived, or undefined while it is being fetched. */
    rowAt: (index: number) => readonly CellValue[] | undefined;
    t: Translate;
  }

  const { mode, columns, rowCount, rowAt, t }: Props = $props();

  const rows = $derived(
    Array.from({ length: Math.min(rowCount, LAYOUT_ROWS) }, (_, index) => rowAt(index)).filter(
      (row): row is readonly CellValue[] => row !== undefined,
    ),
  );
  const json = $derived(mode === 'json' ? rowsToJson(columns, rows) : '');
  const turned = $derived(mode === 'transposed' ? transpose(columns, rows) : undefined);
</script>

<div class="layout" data-testid="result-layout" data-mode={mode}>
  {#if rows.length === 0}
    <p class="empty">{t('layout.empty')}</p>
  {:else}
    <p class="note">{t('layout.rows', rows.length)}</p>
    {#if mode === 'json'}
      <pre class="json" data-testid="layout-json">{json}</pre>
    {:else if turned !== undefined}
      <table class="turned" data-testid="layout-transposed">
        <thead>
          <tr>
            <th scope="col">{t('layout.field')}</th>
            {#each turned.heads as head (head)}
              <th scope="col">{t('layout.row', head)}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each turned.lines as line (line.name)}
            <tr>
              <th scope="row">{line.name}</th>
              {#each line.cells as cell, index (index)}
                <td class:null={cell === null}>{cell === null ? 'NULL' : cellText(cell)}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
</div>

<style>
  .layout {
    flex: 1;
    min-height: 0;
    padding: 8px 14px 14px;
    overflow: auto;
  }

  .note,
  .empty {
    margin: 4px 0 10px;
    color: var(--dn-muted);
    font-size: var(--dn-font-small);
  }

  .json {
    margin: 0;
    padding: 12px 14px;
    font-size: 13px;
    line-height: 1.5;
    background: var(--dn-surface);
    border: 1px solid var(--dn-border);
    border-radius: 12px;
    white-space: pre;
  }

  .turned {
    border-collapse: separate;
    border-spacing: 0;
    font-size: 13px;
  }

  .turned th,
  .turned td {
    max-width: 320px;
    padding: 6px 14px;
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-bottom: 1px solid var(--dn-divider);
  }

  .turned thead th {
    position: sticky;
    top: 0;
    color: var(--dn-muted);
    font-weight: 600;
    background: var(--vscode-editor-background);
  }

  .turned tbody th {
    position: sticky;
    left: 0;
    font-weight: 600;
    background: var(--vscode-editor-background);
  }

  .null {
    color: var(--dn-muted);
    font-style: italic;
  }
</style>
