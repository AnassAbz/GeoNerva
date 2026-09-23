/**
 * Incremental single-linkage clustering over points in space and time (ARCHITECTURE §7.4).
 *
 * This is the geometry half of fire clustering and it knows nothing about fires, databases or
 * cluster identities: it takes points, it returns connected components. The orchestration — which
 * component inherits which cluster id, what a merge means, when an assignment became true — lives
 * in `packages/pipeline/src/fire-cluster.ts`, because all of that is bitemporal bookkeeping rather
 * than geometry.
 *
 * ### Why single-linkage and not DBSCAN
 *
 * ADR-011 settled the algorithm family; this is the part worth restating. DBSCAN's `minPts` exists
 * to label sparse points as **noise**, and noise is exactly the wrong answer here: one VIIRS pixel
 * at 375 m is a real thermal detection over a real place, and dropping it would make a card say
 * "no fire activity" about a fire GeoNerva could see. Single-linkage has no such category — every
 * point belongs to a component, in the limit a component of one — so nothing is silently discarded.
 * Single-linkage's usual weakness, the chaining that lets a thread of points bridge two real
 * clusters, is a fair description of what fire actually does along a front, and the alternative
 * (splitting) is forbidden in v1 anyway.
 *
 * ### Determinism
 *
 * The result must not depend on the order rows come back from the database, because cluster
 * identity is minted from it and a wobbling partition would rewrite public ids. Two things make
 * that true: connectivity is an equivalence relation, so the *partition* is order-independent by
 * construction, and the **order of the output** is fixed to the order of the input. The caller
 * sorts by `(acquired_at, id)` and gets the same components, listed the same way, every run.
 */

import { distanceMetersOrInfinity } from './distance.ts';

/** One point offered for clustering. `id` is opaque and is echoed back untouched. */
export interface LinkablePoint {
  readonly id: string;
  readonly lat: number;
  readonly lon: number;
  /** Acquisition time in epoch milliseconds. */
  readonly atMs: number;
}

export interface SingleLinkageOptions {
  /** Two points link when their geodesic distance is at most this, in metres. */
  readonly epsilonMeters: number;
  /** …and their acquisition times differ by at most this, in milliseconds. */
  readonly maxDeltaMs: number;
  /** The grid-hash cell size in degrees. Only a performance knob; it cannot change the result. */
  readonly cellDegrees: number;
}

/** Metres in one degree of latitude. The spheroid varies by ~1 %; the grid only needs a bound. */
const METRES_PER_LAT_DEGREE = 111_320;

/**
 * Union-find with path halving and union by size.
 *
 * Both optimisations are here for the pathological case this data actually produces: a fire front
 * is a long chain of pixels, and a naive union-find over a chain degrades to O(n) per lookup.
 */
class DisjointSet {
  private readonly parent: number[];
  private readonly size: number[];

  constructor(count: number) {
    this.parent = Array.from({ length: count }, (_, index) => index);
    this.size = new Array<number>(count).fill(1);
  }

  find(node: number): number {
    let current = node;
    while (this.parent[current] !== current) {
      const grandparent = this.parent[this.parent[current] ?? current] ?? current;
      this.parent[current] = grandparent;
      current = grandparent;
    }
    return current;
  }

  union(left: number, right: number): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a === b) return;
    const sizeA = this.size[a] ?? 1;
    const sizeB = this.size[b] ?? 1;
    const [big, small] = sizeA >= sizeB ? [a, b] : [b, a];
    this.parent[small] = big;
    this.size[big] = sizeA + sizeB;
  }
}

/**
 * How many cells either side of a point's own cell can hold something within `epsilon`.
 *
 * Latitude is easy — a degree is a degree. Longitude is not: a degree of longitude shrinks with
 * `cos(lat)`, so at 70° N a 0.02° cell is 760 m wide rather than 2.2 km, and scanning the usual
 * 3×3 window would miss neighbours that are comfortably inside 1.5 km. Getting this wrong produces
 * a bug that is invisible at the latitudes anyone tests by hand and splits every high-latitude fire
 * into stripes — which is why Svalbard is one of this repository's standing test coordinates.
 */
function longitudeCellSpan(
  lat: number,
  options: SingleLinkageOptions,
  totalLonCells: number,
): number {
  const metresPerLonDegree = METRES_PER_LAT_DEGREE * Math.cos((lat * Math.PI) / 180);
  /*
   * At the poles a degree of longitude is worth nothing and the span diverges. Scanning the whole
   * latitude band is the correct answer there and costs nothing, because the band is empty: there
   * are no thermal detections at 89°.
   */
  if (metresPerLonDegree <= 1) return totalLonCells;
  const span = Math.ceil(options.epsilonMeters / (options.cellDegrees * metresPerLonDegree));
  return Math.min(span, totalLonCells);
}

/** Longitude normalised to `[-180, 180)`, so that a cell index is stable across the antimeridian. */
function normaliseLon(lon: number): number {
  const wrapped = (((lon + 180) % 360) + 360) % 360;
  return wrapped - 180;
}

/**
 * Groups points into single-linkage components.
 *
 * Returns components as arrays of ids. Both the components and the ids inside them follow input
 * order, which is what makes the caller's `(acquired_at, id)` ordering reach the result.
 */
export function singleLinkage(
  points: readonly LinkablePoint[],
  options: SingleLinkageOptions,
): readonly (readonly string[])[] {
  if (points.length === 0) return [];

  const totalLonCells = Math.max(1, Math.ceil(360 / options.cellDegrees));
  const latCellOf = (lat: number): number => Math.floor(lat / options.cellDegrees);
  const lonCellOf = (lon: number): number => {
    const index = Math.floor((normaliseLon(lon) + 180) / options.cellDegrees);
    return ((index % totalLonCells) + totalLonCells) % totalLonCells;
  };

  /* The grid hash: cell key to the indices it holds, in input order. */
  const cells = new Map<string, number[]>();
  const keyOf = (latCell: number, lonCell: number): string =>
    `${String(latCell)}:${String(lonCell)}`;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined) continue;
    const key = keyOf(latCellOf(point.lat), lonCellOf(point.lon));
    const bucket = cells.get(key);
    if (bucket === undefined) cells.set(key, [index]);
    else bucket.push(index);
  }

  const sets = new DisjointSet(points.length);

  /*
   * Latitude never needs more than this many cells either side, and with the configured 0.02° grid
   * and a 1.5 km epsilon it is exactly 1 — the classic 3×3 window. It is computed rather than
   * assumed so that changing either constant cannot quietly break the neighbourhood.
   */
  const latSpan = Math.ceil(options.epsilonMeters / (options.cellDegrees * METRES_PER_LAT_DEGREE));

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined) continue;
    const latCell = latCellOf(point.lat);
    const lonCell = lonCellOf(point.lon);
    const lonSpan = longitudeCellSpan(point.lat, options, totalLonCells);

    for (let dLat = -latSpan; dLat <= latSpan; dLat += 1) {
      for (let dLon = -lonSpan; dLon <= lonSpan; dLon += 1) {
        const neighbourLon = (((lonCell + dLon) % totalLonCells) + totalLonCells) % totalLonCells;
        const bucket = cells.get(keyOf(latCell + dLat, neighbourLon));
        if (bucket === undefined) continue;
        for (const other of bucket) {
          /*
           * Only earlier points. Linking is symmetric, so every pair is examined exactly once —
           * when the later of the two is processed — and the work is halved without changing the
           * partition.
           */
          if (other >= index) continue;
          const candidate = points[other];
          if (candidate === undefined) continue;
          if (Math.abs(point.atMs - candidate.atMs) > options.maxDeltaMs) continue;
          /*
           * The exact geodesic check. The grid is a *candidate* filter and is deliberately generous
           * — a cell is square in degrees and the epsilon is a circle in metres — so without this
           * the clusters would be grid-shaped rather than distance-shaped.
           */
          const metres = distanceMetersOrInfinity(
            { lat: point.lat, lon: point.lon },
            { lat: candidate.lat, lon: candidate.lon },
          );
          if (metres <= options.epsilonMeters) sets.union(index, other);
        }
      }
    }
  }

  /*
   * Components in input order: a component is first seen at its lowest member index, and members
   * are appended as they are walked, so both orderings come straight from the caller's sort.
   */
  const componentByRoot = new Map<number, string[]>();
  const order: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined) continue;
    const root = sets.find(index);
    const existing = componentByRoot.get(root);
    if (existing === undefined) {
      componentByRoot.set(root, [point.id]);
      order.push(root);
    } else {
      existing.push(point.id);
    }
  }

  return order.map((root) => componentByRoot.get(root) ?? []);
}
