// Pure "Bloom to Grid" field for the ASCII mandala logo. No DOM, so the same code drives the
// live canvas, the static server frame, and quick checks in Node.
//
// The logo is a fixed GRID x GRID grid of square glyph cells. Settled, it is the real chart:
// 9 blocks of 3x3 squares, each square a 3x3 patch of glyphs, with 1-glyph gutters between
// squares and 2-glyph gutters between blocks (13 glyphs per block, 3 blocks = 39).
//
// The intro: the goal decodes at the center, eight petals open toward the eight outer blocks
// while turning 1/8 of a turn, then the squares crystallize from the middle outward.

export const GRID = 39;
const MID = GRID / 2;
const COUNT = GRID * GRID;

/** Square centers along one axis, relative to the middle, in glyph units. */
const CENTERS = [-17, -13, -9, -4, 0, 4, 9, 13, 17];

/** Seconds. */
export const TIMING = {
  /** The goal glyphs scramble, then resolve. */
  seed: [0, 0.42],
  /** The petals open. */
  bloom: [0.12, 1.2],
  /** Squares crystallize, the middle first and the corners last. */
  grid: [0.72, 2.05],
  /** From here on the chart holds still, apart from the light and the pointer. */
  end: 2.1,
} as const;

/** How long one square takes to crystallize. */
const GRID_MORPH = 0.55;

const ROLE = { none: 0, action: 1, pillar: 2, goalRing: 3, goal: 4 } as const;

/** Color family of a glyph: the gray ramp, or the accent for the goal. */
export const TONE = { ink: 0, accent: 1 } as const;

export const LEVELS = 6;

/**
 * Glyphs per level for each tone, lightest first; level 0 is empty. Ordered by measured ink in
 * Geist Mono. Short and light on purpose: the densest glyph is the goal's.
 */
export const RAMPS = [
  [" ", "·", ":", ";", "+", "*"],
  [" ", "·", ":", "+", "*", "@"],
] as const;

/** Opacity per level for each tone, from a faint gray (about #b4b4b4 on white) to full ink. */
export const ALPHAS = [
  [0, 0.32, 0.45, 0.56, 0.7, 0.86],
  [0, 0.42, 0.56, 0.72, 0.88, 1],
] as const;

/** Vertical nudge in em that centers a glyph's ink in its cell (Geist Mono draws * high). */
export const NUDGE: Readonly<Record<string, number>> = { "*": 0.24, ";": -0.06 };

// The light hovers over the chart and circles its middle. It rests at the upper left.
const ORBIT_RADIUS = 12;
const LIGHT_HEIGHT = 11;
export const LIGHT_HOME_ANGLE = (-3 * Math.PI) / 4;
/** Same point as lightAt(LIGHT_HOME_ANGLE), written without trig so every engine agrees. */
export const LIGHT_HOME = { x: -ORBIT_RADIUS * Math.SQRT1_2, y: -ORBIT_RADIUS * Math.SQRT1_2 };

/** Light position for an orbit angle, relative to the middle, in glyph units. */
export function lightAt(angle: number): { x: number; y: number } {
  return { x: Math.cos(angle) * ORBIT_RADIUS, y: Math.sin(angle) * ORBIT_RADIUS };
}

export interface FieldInput {
  /** Seconds into the intro. At or past TIMING.end it is the settled chart. */
  t: number;
  light: { x: number; y: number };
  /** Scramble the goal glyphs first (the first play only, not replays). */
  decode?: boolean;
  /** Pointer position in glyph units (0 to GRID) and how strongly it lifts, 0-1. */
  px?: number;
  py?: number;
  lift?: number;
}

export interface FieldOutput {
  /** 0-1 per glyph, row-major. */
  ink: Float32Array;
  tone: Uint8Array;
  /** 1 while a goal glyph is scrambling: draw its level as is, without smoothing. */
  scramble: Uint8Array;
}

export function createField(): FieldOutput {
  return { ink: new Float32Array(COUNT), tone: new Uint8Array(COUNT), scramble: new Uint8Array(COUNT) };
}

// ---------- small math ----------

const clamp = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const range = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
const smoothstep = (x: number) => {
  const c = clamp(x);
  return c * c * (3 - 2 * c);
};
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Repeatable pseudo-random 0-1, so a replayed frame looks the same. */
function hash(n: number): number {
  const h = Math.sin(n * 12.9898) * 43758.5453;
  return h - Math.floor(h);
}

// ---------- geometry, computed once ----------

interface Geometry {
  role: Uint8Array;
  /** Offset of the glyph inside its square (-1, 0, 1); 0 in a gutter. */
  u: Int8Array;
  v: Int8Array;
  /** Center of the nearest square, relative to the middle. */
  cx: Float32Array;
  cy: Float32Array;
  /** Signed distance to the nearest square, negative inside. */
  dGrid: Float32Array;
  /** When the nearest square starts to crystallize. */
  gridAt: Float32Array;
}

let geometry: Geometry | null = null;

function nearestCenter(x: number): number {
  let best = CENTERS[0];
  for (const c of CENTERS) if (Math.abs(x - c) < Math.abs(x - best)) best = c;
  return best;
}

function sdRoundBox(qx: number, qy: number, half: number, radius: number): number {
  const dx = Math.abs(qx) - half + radius;
  const dy = Math.abs(qy) - half + radius;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
}

function getGeometry(): Geometry {
  if (geometry) return geometry;
  const g: Geometry = {
    role: new Uint8Array(COUNT),
    u: new Int8Array(COUNT),
    v: new Int8Array(COUNT),
    cx: new Float32Array(COUNT),
    cy: new Float32Array(COUNT),
    dGrid: new Float32Array(COUNT),
    gridAt: new Float32Array(COUNT),
  };
  const farthest = Math.hypot(17, 17);
  const spread = TIMING.grid[1] - TIMING.grid[0] - GRID_MORPH;
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const k = j * GRID + i;
      const x = i + 0.5 - MID;
      const y = j + 0.5 - MID;
      const cx = nearestCenter(x);
      const cy = nearestCenter(y);
      g.cx[k] = cx;
      g.cy[k] = cy;
      g.dGrid[k] = sdRoundBox(x - cx, y - cy, 1.5, 0.55);
      g.gridAt[k] = TIMING.grid[0] + (Math.hypot(cx, cy) / farthest) * spread;
      if (Math.abs(x - cx) > 1.01 || Math.abs(y - cy) > 1.01) continue;
      g.u[k] = Math.round(x - cx);
      g.v[k] = Math.round(y - cy);
      const col = CENTERS.indexOf(cx);
      const row = CENTERS.indexOf(cy);
      const centerBlock = col >= 3 && col <= 5 && row >= 3 && row <= 5;
      const blockCenter = col % 3 === 1 && row % 3 === 1;
      if (centerBlock && blockCenter) g.role[k] = g.u[k] === 0 && g.v[k] === 0 ? ROLE.goal : ROLE.goalRing;
      else if (centerBlock || blockCenter) g.role[k] = ROLE.pillar;
      else g.role[k] = ROLE.action;
    }
  }
  geometry = g;
  return g;
}

// ---------- the settled chart under the light ----------

/** Resting level per role, as [corner, edge, center]: a small dome, densest in the middle. */
const BASE: Record<number, readonly [number, number, number]> = {
  [ROLE.action]: [1, 1, 2],
  [ROLE.pillar]: [2, 2, 5],
  [ROLE.goalRing]: [3, 3, 3],
  [ROLE.goal]: [5, 5, 5],
};

/** Levels the light can add: a glyph moves one step, never more than two. */
const LIGHT_LIFT = 1.15;
/** Light a glyph must receive before it starts to catch it, and how soon it is fully lit. */
const LIT_FROM = 0.3;
const LIT_SPAN = 0.25;

/**
 * Ink of one settled glyph under a point light hovering above the chart. Each square is a low
 * dome, so the glyphs facing the light read one step denser. Square centers and the goal hold
 * still and anchor the chart. Only basic arithmetic and sqrt here: the static frame has to come
 * out bit-identical on the server and in every browser.
 */
function gridInk(k: number, g: Geometry, lx: number, ly: number): number {
  const role = g.role[k];
  if (role === ROLE.none) return 0;
  const u = g.u[k];
  const v = g.v[k];
  const spot = u === 0 && v === 0 ? 2 : u === 0 || v === 0 ? 1 : 0;
  const base = BASE[role][spot];
  if (role === ROLE.goal || role === ROLE.goalRing || spot === 2) return base / (LEVELS - 1);
  const nx = u * 0.7;
  const ny = v * 0.7;
  const tx = lx - g.cx[k] - u;
  const ty = ly - g.cy[k] - v;
  const r2 = tx * tx + ty * ty + LIGHT_HEIGHT * LIGHT_HEIGHT;
  const lambert = (nx * tx + ny * ty + LIGHT_HEIGHT) / Math.sqrt((nx * nx + ny * ny + 1) * r2);
  // Irradiance: facing the light helps, and so does being close to it.
  const light = lambert * ((LIGHT_HEIGHT * LIGHT_HEIGHT) / r2);
  return (base + LIGHT_LIFT * smoothstep((light - LIT_FROM) / LIT_SPAN)) / (LEVELS - 1);
}

// ---------- the lotus ----------

/** Eight petals aimed at the outer blocks, around a seed pod: distance to the edge and density. */
function lotus(x: number, y: number, bloom: number, spin: number): { d: number; w: number } {
  const c = Math.cos(spin);
  const s = Math.sin(spin);
  const qx = x * c - y * s;
  const qy = x * s + y * c;
  const r = Math.hypot(qx, qy);
  const a = Math.atan2(qy, qx);
  const lobe = Math.abs(Math.cos(4 * a));
  // Corner blocks are farther away, so the diagonal petals reach a little longer.
  const reach = (16 + 3.5 * Math.sin(2 * a) ** 2) * bloom;
  const dPetal = r - reach * (0.34 + 0.66 * lobe ** 1.25);
  const dPod = r - 5 * Math.min(1, bloom * 1.6);
  if (dPod < dPetal) return { d: dPod, w: 0.42 };
  const along = reach > 0 ? clamp(r / reach) : 0;
  const midrib = lobe ** 16;
  return { d: dPetal, w: 0.16 + 0.12 * clamp(-dPetal / 4) + 0.24 * midrib * (0.3 + 0.7 * along) };
}

/** Fills `out` with the field at one moment. Cheap enough for every frame (1521 glyphs). */
export function sampleField(input: FieldInput, out: FieldOutput): FieldOutput {
  const g = getGeometry();
  const { t, decode = false } = input;
  const lx = input.light.x;
  const ly = input.light.y;
  const lift = input.lift ?? 0;
  const px = (input.px ?? 0) - MID;
  const py = (input.py ?? 0) - MID;
  const settled = t >= TIMING.end;
  const bloom = easeOut(range(t, TIMING.bloom[0], TIMING.bloom[1]));
  const spin = (1 - easeOut(range(t, TIMING.bloom[0], TIMING.grid[0] + 0.5))) * (Math.PI / 4);
  const [seedStart, seedEnd] = TIMING.seed;

  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const k = j * GRID + i;
      const role = g.role[k];
      const goal = role === ROLE.goal || role === ROLE.goalRing;
      let ink = gridInk(k, g, lx, ly);
      let scramble = 0;

      if (settled) {
        // The settled chart: ink is final.
      } else if (goal) {
        // The goal is there from the first frame. On the first play its glyphs scramble in:
        // the center first, then the ring, each resolving at its own moment.
        const center = role === ROLE.goal;
        const appear = center ? seedStart : seedStart + 0.1 + 0.14 * hash(k + 3);
        const resolve = center ? seedStart + 0.3 : seedEnd - 0.18 + 0.18 * hash(k + 11);
        if (decode && t < appear) ink = 0;
        else if (decode && t < resolve) {
          ink = 0.2 + 0.8 * hash(k * 31 + Math.floor(t / 0.06));
          scramble = 1;
        }
      } else {
        const x = i + 0.5 - MID;
        const y = j + 0.5 - MID;
        const m = easeInOut(range(t, g.gridAt[k], g.gridAt[k] + GRID_MORPH));
        const petal = lotus(x, y, bloom, spin);
        const d = mix(petal.d, g.dGrid[k], m);
        ink = clamp(0.5 - d / 0.9) * mix(petal.w, ink, m);
      }

      // The pointer lifts the glyphs near it, all but the anchors (goal and square centers).
      const anchor = goal || (role !== ROLE.none && g.u[k] === 0 && g.v[k] === 0);
      if (lift > 0 && ink > 0 && !anchor) {
        const dx = i + 0.5 - MID - px;
        const dy = j + 0.5 - MID - py;
        ink += lift * 0.3 * Math.min(1, ink * 5) * Math.exp(-(dx * dx + dy * dy) / 24);
      }
      out.ink[k] = clamp(ink);
      out.tone[k] = goal ? TONE.accent : TONE.ink;
      out.scramble[k] = scramble;
    }
  }
  return out;
}

/** Level (0 to LEVELS - 1) for an ink value. */
export function levelOf(ink: number): number {
  return Math.min(LEVELS - 1, Math.round(ink * (LEVELS - 1)));
}

export interface StaticGlyphs {
  tone: number;
  level: number;
  /** Column and row of each glyph. */
  cells: { i: number; j: number }[];
}

/**
 * The settled chart under the resting light, grouped by tone and level, for drawing without a
 * canvas (server render and first paint). Deterministic in every JavaScript engine.
 */
export function settledGlyphs(): StaticGlyphs[] {
  const field = sampleField({ t: TIMING.end, light: LIGHT_HOME }, createField());
  const groups = new Map<number, StaticGlyphs>();
  for (let k = 0; k < COUNT; k++) {
    const level = levelOf(field.ink[k]);
    if (!level) continue;
    const tone = field.tone[k];
    const key = tone * LEVELS + level;
    let group = groups.get(key);
    if (!group) {
      group = { tone, level, cells: [] };
      groups.set(key, group);
    }
    group.cells.push({ i: k % GRID, j: Math.floor(k / GRID) });
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group);
}
