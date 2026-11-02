// Side-by-side placement of items that overlap in time, the column layout calendars use. Items
// that overlap each other, directly or through a chain (A overlaps B, B overlaps C), form a
// cluster. Each item takes the first column of its cluster that is free at its start, every item
// of a cluster is 1/columns wide, and an item stretches right over the columns next to it that
// stay free for its whole length.

export interface Interval {
  // Start and end on one axis (minutes in the calendar). `bottom` may equal `top`.
  readonly top: number;
  readonly bottom: number;
}

export interface ColumnPlacement {
  // The first column the item covers, the number of columns it covers, and its cluster's width.
  readonly column: number;
  readonly span: number;
  readonly columns: number;
}

interface Entry<T> {
  readonly item: T;
  readonly index: number;
  readonly top: number;
  readonly bottom: number;
}

// Zero-length items still take a point in time: two of them at the same moment collide.
const collide = (a: Interval, b: Interval): boolean =>
  (a.top < b.bottom && b.top < a.bottom) || a.top === b.top;

// `minLength` is the shortest length an item is drawn with; shorter items take that much room so
// their blocks do not cover the next item. The result is in start order (longer first on a tie,
// then input order), which is also the order the grid renders and tabs through.
export function layoutColumns<T extends Interval>(
  items: readonly T[],
  minLength = 0,
): (T & ColumnPlacement)[] {
  const entries: Entry<T>[] = items
    .map((item, index) => ({
      item,
      index,
      top: item.top,
      bottom: Math.max(item.bottom, item.top + minLength),
    }))
    .toSorted((a, b) => a.top - b.top || b.bottom - a.bottom || a.index - b.index);

  const placed: (T & ColumnPlacement)[] = [];
  // The open cluster: its columns, and its items in start order with the column each took.
  let cluster: Entry<T>[][] = [];
  let order: { entry: Entry<T>; column: number }[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;
  let lastTop = Number.NaN;

  const flush = () => {
    const columns = cluster.length;
    for (const { entry, column } of order) {
      let span = 1;
      while (
        column + span < columns &&
        !(cluster[column + span] ?? []).some((other) => collide(other, entry))
      ) {
        span += 1;
      }
      placed.push({ ...entry.item, column, span, columns });
    }
    cluster = [];
    order = [];
  };

  for (const entry of entries) {
    if (entry.top >= clusterEnd && entry.top !== lastTop) {
      flush();
      clusterEnd = Number.NEGATIVE_INFINITY;
    }
    let column = cluster.findIndex((members) => !members.some((other) => collide(other, entry)));
    if (column === -1) {
      column = cluster.length;
      cluster.push([]);
    }
    cluster[column]?.push(entry);
    order.push({ entry, column });
    clusterEnd = Math.max(clusterEnd, entry.bottom);
    lastTop = entry.top;
  }
  flush();
  return placed;
}
