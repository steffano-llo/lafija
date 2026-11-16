/** Card ids per stage id, in board order: the client-side state of the board. */
export type Columns = Record<string, string[]>;

/** The column holding `id`, or `id` itself when it is a column. */
export function findColumn(columns: Columns, id: string): string | undefined {
  if (id in columns) return id;
  return Object.keys(columns).find((column) => columns[column].includes(id));
}

/** Column and index of a card. */
export function locate(columns: Columns, cardId: string): { column: string; index: number } | undefined {
  const column = findColumn(columns, cardId);
  if (!column || column === cardId) return undefined;
  return { column, index: columns[column].indexOf(cardId) };
}

/**
 * Moves a card next to `overId` (a card or a column). Over a card: takes that card's place.
 * Over a column: goes to its bottom. Returns the same object when nothing changes.
 */
export function moveCard(columns: Columns, cardId: string, overId: string): Columns {
  const from = locate(columns, cardId);
  const toColumn = findColumn(columns, overId);
  if (!from || !toColumn || overId === cardId) return columns;

  const source = columns[from.column].filter((id) => id !== cardId);
  const target = from.column === toColumn ? source : [...columns[toColumn]];
  const overIndex = overId === toColumn ? -1 : columns[toColumn].indexOf(overId);
  const index = overIndex < 0 ? target.length : overIndex;
  if (from.column === toColumn && index === from.index) return columns;

  target.splice(index, 0, cardId);
  return from.column === toColumn
    ? { ...columns, [toColumn]: target }
    : { ...columns, [from.column]: source, [toColumn]: target };
}
