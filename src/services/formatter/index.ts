// The formatter bundle (dist/formatter.js): sql-formatter is large, so it is loaded
// only when the user first formats something (ARCHITECTURE.md §7).

import { format } from 'sql-formatter';
import type { FormatterModule } from '../sql-format';

export const formatter: FormatterModule = {
  format: (sql, language, style) =>
    format(sql, {
      language,
      keywordCase: style.keywordCase,
      dataTypeCase: style.dataTypeCase,
      functionCase: style.functionCase,
      indentStyle: style.indentStyle,
      logicalOperatorNewline: style.logicalOperatorNewline,
      expressionWidth: style.expressionWidth,
      denseOperators: style.denseOperators,
      tabWidth: style.tabWidth,
      useTabs: style.useTabs,
    }),
};
