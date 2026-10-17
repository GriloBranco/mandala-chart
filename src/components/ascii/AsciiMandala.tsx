"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import {
  ALPHAS,
  GRID,
  LEVELS,
  LIGHT_HOME,
  LIGHT_HOME_ANGLE,
  NUDGE,
  RAMPS,
  TIMING,
  TONE,
  createField,
  levelOf,
  lightAt,
  sampleField,
  settledGlyphs,
} from "@/lib/ascii-field";

// "Bloom to Grid": the goal decodes at the center, eight petals open and square off into the
// real 9x9 chart. Once settled, a slow light orbits the chart and the pointer lifts the squares
// under it. A tap replays the bloom. Decorative: it never takes focus or blocks scrolling.

const FONT_WEIGHT = 600;
/** Glyph size relative to its cell. */
const FONT_SCALE = 1.1;
const FPS_INTRO = 30;
const FPS_IDLE = 20;
/** One turn of the light, in seconds. */
const ORBIT_SECONDS = 9;
/** The light comes to rest after this long without a pointer, to save battery. */
const IDLE_SECONDS = 20;
/** A tap rewinds the bloom this many times faster than it plays. */
const REWIND_SPEED = 3.5;
/** A glyph keeps its level until the ink moves this far past the boundary, so it never flickers. */
const HYSTERESIS = 0.14;
/** Longest wait for Geist Mono before drawing with the fallback (it redraws when the font lands). */
const FONT_TIMEOUT = 1500;
const COUNT = GRID * GRID;

export function AsciiMandala({
  className,
  intro = false,
  label = "Mandala logo",
  idle = true,
}: {
  /** Set the width here; the height follows (always square). */
  className?: string;
  /** Play the bloom on mount. False starts settled. */
  intro?: boolean;
  label?: string;
  /** Once settled, let a slow light orbit the chart. */
  idle?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const logoRef = useRef<LiveLogo | null>(null);
  // Only the value at mount counts: flipping it later should not replay the bloom.
  const [introAtMount] = useState(intro);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas) return;
    const logo = new LiveLogo(box, canvas, introAtMount, () => setLive(true));
    logoRef.current = logo;
    return () => {
      logo.destroy();
      logoRef.current = null;
    };
  }, [introAtMount]);

  useEffect(() => {
    logoRef.current?.setIdle(idle);
  }, [idle]);

  // Paint again as soon as the canvas is visible, before the browser paints, so the swap from the
  // static frame can never show an empty square.
  useLayoutEffect(() => {
    if (live) logoRef.current?.repaint();
  }, [live]);

  return (
    <div
      ref={boxRef}
      role="img"
      aria-label={label}
      className={cn("relative aspect-square touch-manipulation select-none", className)}
    >
      {!live && (
        // Server render and first paint: the settled chart as SVG text, glyph for glyph the same
        // as the canvas. With the intro it stays hidden (unless motion is reduced), so the bloom
        // starts from an empty square instead of flashing the finished chart first.
        <StaticChart className={introAtMount ? "hidden motion-reduce:block" : undefined} />
      )}
      <canvas
        ref={canvasRef}
        aria-hidden
        // transition-none: under reduced motion, globals.css gives everything a 1ms transition,
        // which would make the swap from the static frame blink.
        className={cn("pointer-events-none absolute inset-0 size-full transition-none", !live && "invisible")}
      />
    </div>
  );
}

// ---------- static frame ----------

/** SVG user units per glyph cell. */
const UNIT = 10;

interface StaticGroup {
  key: string;
  x: string;
  y: string;
  text: string;
  fill: string;
  opacity: number;
}

let staticGroups: StaticGroup[] | null = null;

function getStaticGroups(): StaticGroup[] {
  staticGroups ??= settledGlyphs().map(({ tone, level, cells }) => {
    const glyph = RAMPS[tone][level];
    const nudge = (NUDGE[glyph] ?? 0) * UNIT * FONT_SCALE;
    return {
      key: `${tone}-${level}`,
      x: cells.map(({ i }) => (i + 0.5) * UNIT).join(" "),
      y: cells.map(({ j }) => +((j + 0.5) * UNIT + nudge).toFixed(2)).join(" "),
      text: glyph.repeat(cells.length),
      fill: tone === TONE.accent ? "var(--accent)" : "var(--fg)",
      opacity: ALPHAS[tone][level],
    };
  });
  return staticGroups;
}

/** The settled chart as SVG text, each glyph placed on its own cell like on the canvas. */
function StaticChart({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${GRID * UNIT} ${GRID * UNIT}`}
      className={cn("pointer-events-none absolute inset-0 size-full overflow-visible font-mono", className)}
      style={{ fontWeight: FONT_WEIGHT }}
    >
      {getStaticGroups().map((group) => (
        <text
          key={group.key}
          x={group.x}
          y={group.y}
          fontSize={UNIT * FONT_SCALE}
          textAnchor="middle"
          dominantBaseline="central"
          style={{ fill: group.fill, fillOpacity: group.opacity }}
        >
          {group.text}
        </text>
      ))}
    </svg>
  );
}

// ---------- live canvas ----------

/** Any CSS color (hex, rgb(), oklch()...) normalized by the canvas, or the fallback. */
function readColor(probe: CanvasRenderingContext2D, value: string, fallback: string): string {
  probe.fillStyle = fallback;
  if (value) probe.fillStyle = value;
  return String(probe.fillStyle);
}

function monoFamily(): string {
  const geist = getComputedStyle(document.documentElement).getPropertyValue("--font-geist-mono").trim();
  return `${geist ? `${geist}, ` : ""}ui-monospace, SFMono-Regular, Menlo, monospace`;
}

/**
 * Draws the field on a canvas: a glyph atlas baked at the device pixel ratio (capped at 2), and
 * per frame only the glyphs whose tile changed. Time comes from rAF timestamps. The loop runs
 * only while something moves, and pauses off-screen, in a hidden tab, and for reduced motion.
 */
class LiveLogo {
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly field = createField();
  /** Smoothed level per glyph, and the atlas tile on screen per glyph (-1 = unknown). */
  private readonly level = new Int8Array(COUNT).fill(-1);
  private readonly drawn = new Int16Array(COUNT).fill(-1);
  private atlas: HTMLCanvasElement | null = null;
  private tile = 0;
  /** Device-pixel edges of the columns (and rows), and where each cell reads from its tile. */
  private readonly edges = new Int32Array(GRID + 1);
  private readonly shift = new Int32Array(GRID);
  private cssSize = 0;
  private dpr = 1;
  private readonly family = monoFamily();

  // timeline
  private t: number;
  private decode: boolean;
  private rewinding = false;
  /** Seconds the loop has run; measures the idle window. */
  private clock = 0;
  private idleUntil = IDLE_SECONDS;
  private idle = true;
  private angle = LIGHT_HOME_ANGLE;
  private omega = 0;

  // pointer, in glyph units, eased toward where it really is
  private pointer: { x: number; y: number } | null = null;
  private px = GRID / 2;
  private py = GRID / 2;
  private lift = 0;

  // loop and environment
  private raf = 0;
  private last: number | null = null;
  private started = false;
  private destroyed = false;
  private onScreen = true;
  private fontTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  private readonly scheme = window.matchMedia("(prefers-color-scheme: dark)");
  private resolution: MediaQueryList | null = null;
  private readonly resizeObserver: ResizeObserver;
  private readonly intersectionObserver: IntersectionObserver | null = null;

  constructor(
    private readonly box: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    intro: boolean,
    private readonly onLive: () => void,
  ) {
    this.ctx = canvas.getContext("2d");
    this.t = intro && !this.reduce.matches ? 0 : TIMING.end;
    this.decode = intro;

    this.resizeObserver = new ResizeObserver(() => this.relayout());
    this.resizeObserver.observe(box);
    if (typeof IntersectionObserver !== "undefined") {
      this.intersectionObserver = new IntersectionObserver(([entry]) => {
        this.onScreen = entry?.isIntersecting ?? true;
        this.wake();
      });
      this.intersectionObserver.observe(box);
    }
    this.reduce.addEventListener("change", this.onReduceChange);
    this.scheme.addEventListener("change", this.onRebuild);
    document.addEventListener("visibilitychange", this.onVisibility);
    box.addEventListener("pointerenter", this.onPointer);
    box.addEventListener("pointermove", this.onPointer);
    box.addEventListener("pointerdown", this.onPointer);
    box.addEventListener("pointerup", this.onPointerUp);
    box.addEventListener("pointerleave", this.onPointerEnd);
    box.addEventListener("pointercancel", this.onPointerEnd);
    box.addEventListener("click", this.onClick);
    canvas.addEventListener("contextrestored", this.onRepaint);

    // Draw once Geist Mono is ready (the glyph shapes depend on it), or after a short wait.
    const fonts = document.fonts;
    const timeout = new Promise((resolve) => {
      this.fontTimer = setTimeout(resolve, FONT_TIMEOUT);
    });
    const loaded = fonts
      ? Promise.all([fonts.load(`${FONT_WEIGHT} 16px ${this.family}`, RAMPS.flat().join("")), fonts.ready])
      : Promise.resolve();
    Promise.race([loaded, timeout])
      .catch(() => undefined)
      .then(() => this.start());
    // If the font lands after the wait, bake the glyphs again with it.
    fonts?.addEventListener("loadingdone", this.onRebuild);
  }

  setIdle(idle: boolean) {
    this.idle = idle;
    if (idle) this.idleUntil = this.clock + IDLE_SECONDS;
    this.wake();
  }

  /** Redraws every glyph: after the canvas becomes visible, or its context comes back. */
  repaint() {
    this.drawn.fill(-1);
    this.draw();
  }

  destroy() {
    this.destroyed = true;
    this.stop();
    clearTimeout(this.fontTimer);
    this.resizeObserver.disconnect();
    this.intersectionObserver?.disconnect();
    this.reduce.removeEventListener("change", this.onReduceChange);
    this.scheme.removeEventListener("change", this.onRebuild);
    this.resolution?.removeEventListener("change", this.onRebuild);
    document.removeEventListener("visibilitychange", this.onVisibility);
    document.fonts?.removeEventListener("loadingdone", this.onRebuild);
    const box = this.box;
    box.removeEventListener("pointerenter", this.onPointer);
    box.removeEventListener("pointermove", this.onPointer);
    box.removeEventListener("pointerdown", this.onPointer);
    box.removeEventListener("pointerup", this.onPointerUp);
    box.removeEventListener("pointerleave", this.onPointerEnd);
    box.removeEventListener("pointercancel", this.onPointerEnd);
    box.removeEventListener("click", this.onClick);
    this.canvas.removeEventListener("contextrestored", this.onRepaint);
    this.atlas = null;
  }

  // ---------- setup ----------

  private start() {
    if (this.destroyed || this.started || !this.ctx) return;
    this.started = true;
    this.relayout();
    this.onLive();
    this.wake();
  }

  /** Re-bakes the atlas when the size or pixel ratio changed, then draws. */
  private relayout(force = false) {
    if (!this.started || this.destroyed) return;
    const size = this.box.clientWidth;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (force || size !== this.cssSize || dpr !== this.dpr || !this.atlas) {
      this.cssSize = size;
      this.dpr = dpr;
      this.buildAtlas();
      this.watchResolution();
    }
    this.draw();
  }

  private watchResolution() {
    // Moving the window to a screen with another pixel ratio does not resize the box.
    this.resolution?.removeEventListener("change", this.onRebuild);
    this.resolution = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.resolution.addEventListener("change", this.onRebuild);
  }

  private buildAtlas() {
    const ctx = this.ctx;
    this.atlas = null;
    if (!ctx || this.cssSize <= 0) return;
    const px = Math.max(GRID, Math.round(this.cssSize * this.dpr));
    this.canvas.width = px;
    this.canvas.height = px;
    // Cells sit on whole device pixels; a tile is a little larger than a cell and each cell
    // copies the middle of its tile, so glyphs stay centered and never bleed into neighbors.
    const cell = px / GRID;
    const tile = Math.ceil(cell) + 2;
    for (let i = 0; i <= GRID; i++) this.edges[i] = Math.round(i * cell);
    for (let i = 0; i < GRID; i++) this.shift[i] = (tile - (this.edges[i + 1] - this.edges[i])) >> 1;
    this.tile = tile;

    const atlas = document.createElement("canvas");
    atlas.width = tile * LEVELS * 2;
    atlas.height = tile;
    const a = atlas.getContext("2d");
    if (!a) return;
    const style = getComputedStyle(this.box);
    const colors = [
      readColor(a, style.getPropertyValue("--fg").trim(), "#111111"),
      readColor(a, style.getPropertyValue("--accent").trim(), "#ff4f00"),
    ];
    const fontPx = cell * FONT_SCALE;
    a.font = `${FONT_WEIGHT} ${fontPx}px ${this.family}`;
    a.textAlign = "center";
    a.textBaseline = "middle";
    for (const tone of [TONE.ink, TONE.accent]) {
      a.fillStyle = colors[tone];
      for (let level = 1; level < LEVELS; level++) {
        const glyph = RAMPS[tone][level];
        a.globalAlpha = ALPHAS[tone][level];
        a.fillText(glyph, (tone * LEVELS + level + 0.5) * tile, tile / 2 + (NUDGE[glyph] ?? 0) * fontPx);
      }
    }
    this.atlas = atlas;
    this.drawn.fill(-1);
    ctx.clearRect(0, 0, px, px);
  }

  // ---------- loop ----------

  private get running(): boolean {
    return this.started && !this.destroyed && this.onScreen && !document.hidden && !this.reduce.matches;
  }

  private get orbitTarget(): number {
    const on = this.idle && this.t >= TIMING.end && !this.rewinding && this.clock < this.idleUntil;
    return on ? (2 * Math.PI) / ORBIT_SECONDS : 0;
  }

  /** True while anything is still moving. */
  private get busy(): boolean {
    if (this.t < TIMING.end || this.rewinding) return true;
    if (this.omega > 0 || this.orbitTarget > 0) return true;
    if (Math.abs(this.lift - (this.pointer ? 1 : 0)) > 2e-3) return true;
    return !!this.pointer && Math.abs(this.px - this.pointer.x) + Math.abs(this.py - this.pointer.y) > 0.02;
  }

  /** Starts the loop if something moves, or stops it if the logo cannot be seen. */
  private wake() {
    if (!this.running) this.stop();
    else if (!this.raf && this.busy) this.raf = requestAnimationFrame(this.frame);
  }

  private stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = null;
  }

  private readonly frame = (now: number) => {
    this.raf = 0;
    if (!this.running) {
      this.last = null;
      return;
    }
    const fps = this.t < TIMING.end || this.rewinding ? FPS_INTRO : FPS_IDLE;
    if (this.last !== null && now - this.last < 1000 / fps - 2) {
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    // A long gap (paused tab, busy phone) never makes the animation jump ahead.
    const dt = this.last === null ? 0 : Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.step(dt);
    this.draw();
    if (this.busy) this.raf = requestAnimationFrame(this.frame);
    else this.last = null;
  };

  private step(dt: number) {
    this.clock += dt;
    if (this.rewinding) {
      this.t -= dt * REWIND_SPEED;
      if (this.t <= TIMING.bloom[0]) {
        this.t = TIMING.bloom[0];
        this.rewinding = false;
      }
    } else if (this.t < TIMING.end) {
      this.t = Math.min(TIMING.end, this.t + dt);
      if (this.t >= TIMING.end) this.idleUntil = this.clock + IDLE_SECONDS;
    }

    // The light speeds up and slows down gently instead of starting or stopping dead.
    const target = this.orbitTarget;
    this.omega += (target - this.omega) * (1 - Math.exp(-dt / 0.9));
    if (target === 0 && this.omega < 0.01) this.omega = 0;
    this.angle += this.omega * dt;

    const pointer = this.pointer;
    this.lift += ((pointer ? 1 : 0) - this.lift) * (1 - Math.exp(-dt / 0.18));
    if (pointer) {
      const follow = 1 - Math.exp(-dt / 0.07);
      this.px += (pointer.x - this.px) * follow;
      this.py += (pointer.y - this.py) * follow;
    }
  }

  private draw() {
    const ctx = this.ctx;
    const atlas = this.atlas;
    if (!ctx || !atlas) return;
    const light = this.angle === LIGHT_HOME_ANGLE ? LIGHT_HOME : lightAt(this.angle);
    sampleField(
      { t: this.t, light, decode: this.decode, px: this.px, py: this.py, lift: this.lift },
      this.field,
    );
    const { ink, tone, scramble } = this.field;
    const { edges, shift, tile } = this;
    for (let j = 0; j < GRID; j++) {
      const y0 = edges[j];
      const h = edges[j + 1] - y0;
      for (let i = 0; i < GRID; i++) {
        const k = j * GRID + i;
        const level = scramble[k] ? levelOf(ink[k]) : this.smooth(k, ink[k]);
        const id = level ? tone[k] * LEVELS + level : 0;
        if (id === this.drawn[k]) continue;
        this.drawn[k] = id;
        const x0 = edges[i];
        const w = edges[i + 1] - x0;
        ctx.clearRect(x0, y0, w, h);
        if (id) ctx.drawImage(atlas, id * tile + shift[i], shift[j], w, h, x0, y0, w, h);
      }
    }
  }

  private smooth(k: number, ink: number): number {
    const x = ink * (LEVELS - 1);
    const prev = this.level[k];
    let next = levelOf(ink);
    if (prev >= 0 && next !== prev && Math.abs(x - prev) < 0.5 + HYSTERESIS) next = prev;
    this.level[k] = next;
    return next;
  }

  // ---------- events ----------

  private readonly onPointer = (event: PointerEvent) => {
    if (this.reduce.matches || this.cssSize <= 0) return;
    const scale = GRID / this.cssSize;
    const x = event.offsetX * scale;
    const y = event.offsetY * scale;
    if (!this.pointer) {
      // Start the lift where the pointer is, not where it last left.
      this.px = x;
      this.py = y;
    }
    this.pointer = { x, y };
    this.idleUntil = this.clock + IDLE_SECONDS;
    this.wake();
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") this.onPointerEnd();
  };

  private readonly onPointerEnd = () => {
    this.pointer = null;
    this.wake();
  };

  private readonly onClick = () => {
    if (this.reduce.matches || !this.started) return;
    // Taps while the petals are still opening are ignored: restarting mid-bloom feels like a glitch.
    if (this.t < TIMING.grid[0] && !this.rewinding) return;
    this.rewinding = true;
    this.decode = false;
    this.wake();
  };

  private readonly onVisibility = () => {
    if (!document.hidden) this.repaint();
    this.wake();
  };

  private readonly onRepaint = () => this.repaint();

  private readonly onRebuild = () => this.relayout(true);

  private readonly onReduceChange = () => {
    if (this.reduce.matches) {
      this.t = TIMING.end;
      this.rewinding = false;
      this.omega = 0;
      this.angle = LIGHT_HOME_ANGLE;
      this.pointer = null;
      this.lift = 0;
      this.level.fill(-1);
      this.draw();
    }
    this.wake();
  };
}
