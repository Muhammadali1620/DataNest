<script lang="ts">
  interface Props {
    title?: string;
  }

  const { title = 'DataNest' }: Props = $props();
</script>

<main>
  <h1>{title}</h1>
  <p data-testid="status">ready</p>
</main>

<style>
  main {
    padding: 12px 16px;
  }

  h1 {
    margin: 0 0 8px;
    font-size: 1.4em;
    font-weight: 600;
  }

  p {
    margin: 0;
    color: var(--vscode-descriptionForeground);
  }
</style>
