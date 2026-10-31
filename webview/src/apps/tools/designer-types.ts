// What the designer's canvas and its section share.

export type Tool = 'select' | 'rect' | 'circle' | 'ellipse' | 'line' | 'text' | 'path';

/** What a new shape looks like. */
export interface Pen {
  readonly fill: string;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly opacity: number;
}
