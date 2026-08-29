// Bot avatar — the Blob Studio "Cursor" mascot (CursorAvatar.tsx), wrapped
// in the app's historical MausAvatar API so no call site changes: per-bot
// color becomes a body gradient, the app's one-shot motion beats borrow the
// face/state for a moment, and the eyes follow the pointer. The previous
// hand-built Maus body + face engine (maus-engine/face/driver) is gone;
// CursorAvatar owns morphing, blinking, drift, body motion and effects.
import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { MAUS_COLORS, type MausColor, type MausMotion, type MausState } from "@/lib/mascot";
import {
  CursorAvatar,
  type CursorAvatarHandle,
} from "./CursorAvatar";
import { proceduralAvatarPresentation } from "@/lib/procedural-avatar";
import {
  botAvatarProfile,
  type BotAvatarCrop,
  type BotProceduralAvatar,
} from "../../shared/bot-avatar";

/**
 * Legacy face-placement knobs from the Maus body era. The cursor mascot
 * places its own face; these remain only so the preview harness's sliders
 * keep compiling — the matching props are accepted and ignored.
 */
export const FACE_X = 80;
export const FACE_Y = 102;
export const FACE_SCALE = 0.47;
export const EYE_SCALE = 1.12;
export const MOUTH_WEIGHT = 11;

/**
 * How far the pointer may pull the eyes. Facing forward the full range is
 * safe; with the expressions' authored gaze they already start off-centre.
 */
const POINTER_GAZE = { forward: 1, authored: 0.25 };

/**
 * What a one-shot motion does while it plays: CursorAvatar animates the body
 * per state, so borrowing the state for a beat moves body and face together.
 */
interface MotionFaces
  extends Partial<
    Record<Exclude<MausMotion, "none">, { state?: MausState; blink?: boolean; spin?: number }>
  > {}

const MOTION_FACE: MotionFaces = {
  arrive: { state: "spawning", spin: 900 },
  switch: { state: "waking", spin: 620 },
  customize: { state: "proud", blink: true },
  alert: { state: "alerting" },
  thinking: { state: "thinking" },
  working: { state: "working" },
  launch: { state: "loading" },
  success: { state: "happy", blink: true },
  celebrate: { state: "celebrate", spin: 700 },
  blink: { blink: true },
  surprise: { state: "surprised", blink: true },
  failure: { state: "sad" },
};

/** How long a one-shot motion holds its state before the bot's own returns. */
const MOTION_FACE_MS = 1400;

/** Channel-wise mix of a hex color toward another, t in 0..1. */
function mix(hex: string, toward: string, t: number): string {
  const a = Number.parseInt(hex.slice(1), 16);
  const b = Number.parseInt(toward.slice(1), 16);
  const channel = (shift: number) => {
    const va = (a >> shift) & 0xff;
    const vb = (b >> shift) & 0xff;
    return Math.round(va + (vb - va) * t);
  };
  return `#${[channel(16), channel(8), channel(0)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * Bot color -> the mascot's three-stop body gradient (highlight, base,
 * shadow), with the same light/dark spread as the pack's default green
 * ["#9FE6B5", "#3FAE6E", "#1C7A4C"].
 */
const gradientFor = (color: MausColor): [string, string, string] => {
  const fill = MAUS_COLORS[color] ?? MAUS_COLORS.green;
  return [mix(fill, "#ffffff", 0.55), fill, mix(fill, "#000000", 0.42)];
};

/** One screen-upright white face, independent from animated body geometry. */
export const CANONICAL_FACE_CONTRACT = {
  eyeWidth: 5,
  eyeHeight: 13,
  eyeGap: 9,
  eyeCenterY: 45,
  mouthWidth: 8,
  mouthCenterY: 68,
  mouthStrokeWidth: 2.8,
} as const;

type FaceRecipe = Readonly<{
  eyeScaleX: number;
  eyeScaleY: number;
  eyeShiftX: number;
  eyeShiftY: number;
  mouthCurve: number;
}>;

const FACE_RECIPE = {
  idle: { eyeScaleX: 1, eyeScaleY: 1, eyeShiftX: 0, eyeShiftY: 0, mouthCurve: 0.7 },
  happy: { eyeScaleX: 1, eyeScaleY: 0.92, eyeShiftX: 0, eyeShiftY: 0.5, mouthCurve: 1.2 },
  surprised: { eyeScaleX: 1.04, eyeScaleY: 1.16, eyeShiftX: 0, eyeShiftY: -1, mouthCurve: 0.8 },
  sleepy: { eyeScaleX: 1, eyeScaleY: 0.55, eyeShiftX: 0, eyeShiftY: 2, mouthCurve: -0.5 },
  focused: { eyeScaleX: 0.98, eyeScaleY: 0.9, eyeShiftX: 1, eyeShiftY: 0.5, mouthCurve: 0.2 },
  curious: { eyeScaleX: 1, eyeScaleY: 1, eyeShiftX: -1, eyeShiftY: 0, mouthCurve: 0.7 },
  stern: { eyeScaleX: 1, eyeScaleY: 0.82, eyeShiftX: 0, eyeShiftY: 1, mouthCurve: -0.7 },
  sad: { eyeScaleX: 0.96, eyeScaleY: 0.9, eyeShiftX: 0, eyeShiftY: 0.5, mouthCurve: -0.8 },
} as const satisfies Record<string, FaceRecipe>;

export function canonicalFaceRecipeForState(state: MausState): FaceRecipe {
  if (["happy", "celebrate", "excited", "laughing", "proud", "playful"].includes(state)) return FACE_RECIPE.happy;
  if (["surprised", "scared", "notifying", "spawning"].includes(state)) return FACE_RECIPE.surprised;
  if (["sleeping", "drowsy", "powering-down"].includes(state)) return FACE_RECIPE.sleepy;
  if (["thinking", "searching", "working", "loading", "writing", "uploading", "progress", "radar"].includes(state)) return FACE_RECIPE.focused;
  if (["curious", "listening", "receiving", "dictating"].includes(state)) return FACE_RECIPE.curious;
  if (["alerting", "angry", "suspicious"].includes(state)) return FACE_RECIPE.stern;
  if (["sad", "bored", "shy"].includes(state)) return FACE_RECIPE.sad;
  return FACE_RECIPE.idle;
}

const snapHalf = (value: number) => Math.round(value * 2) / 2;

export function canonicalFaceBounds(
  faceOffset: Readonly<{ x: number; y: number }>,
  faceScale: number,
  opticalScale: number,
) {
  const recipe = FACE_RECIPE.surprised;
  const eyeWidth = CANONICAL_FACE_CONTRACT.eyeWidth * recipe.eyeScaleX;
  const eyeHeight = CANONICAL_FACE_CONTRACT.eyeHeight * recipe.eyeScaleY;
  const left = 50 - CANONICAL_FACE_CONTRACT.eyeGap / 2 - eyeWidth / 2 + recipe.eyeShiftX;
  const right = 50 + CANONICAL_FACE_CONTRACT.eyeGap / 2 + eyeWidth / 2 + recipe.eyeShiftX;
  const top = CANONICAL_FACE_CONTRACT.eyeCenterY + recipe.eyeShiftY - eyeHeight / 2;
  const bottom = Math.max(
    CANONICAL_FACE_CONTRACT.eyeCenterY + recipe.eyeShiftY + eyeHeight / 2,
    CANONICAL_FACE_CONTRACT.mouthCenterY + 1.2 + CANONICAL_FACE_CONTRACT.mouthStrokeWidth / 2,
  );
  const x = (value: number) =>
    50 + ((value - 50) * faceScale + faceOffset.x) * opticalScale;
  const y = (value: number) =>
    50 + ((value - 50) * faceScale + faceOffset.y) * opticalScale;
  return { left: x(left), right: x(right), top: y(top), bottom: y(bottom) };
}

function CanonicalFaceRig({
  state,
  faceScale,
  faceOffset,
  gaze,
  showMouth,
  mouthStroke,
}: {
  state: MausState;
  faceScale: number;
  faceOffset: Readonly<{ x: number; y: number }>;
  gaze: Readonly<{ x: number; y: number }>;
  showMouth: boolean;
  mouthStroke: number;
}) {
  const recipe = canonicalFaceRecipeForState(state);
  const eyeWidth = snapHalf(CANONICAL_FACE_CONTRACT.eyeWidth * recipe.eyeScaleX);
  const eyeHeight = snapHalf(CANONICAL_FACE_CONTRACT.eyeHeight * recipe.eyeScaleY);
  const gazeX = Math.max(-1.5, Math.min(1.5, gaze.x));
  const gazeY = Math.max(-1, Math.min(1, gaze.y));
  const leftX = snapHalf(50 - CANONICAL_FACE_CONTRACT.eyeGap / 2 - eyeWidth / 2 + recipe.eyeShiftX + gazeX);
  const rightX = snapHalf(50 + CANONICAL_FACE_CONTRACT.eyeGap / 2 - eyeWidth / 2 + recipe.eyeShiftX + gazeX);
  const eyeY = snapHalf(CANONICAL_FACE_CONTRACT.eyeCenterY + recipe.eyeShiftY - eyeHeight / 2 + gazeY);
  const mouthY = snapHalf(CANONICAL_FACE_CONTRACT.mouthCenterY);
  const mouthHalfWidth = CANONICAL_FACE_CONTRACT.mouthWidth / 2;
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full overflow-visible"
    >
      <g transform={`translate(${50 + faceOffset.x} ${50 + faceOffset.y}) scale(${faceScale}) translate(-50 -50)`}>
        <rect x={leftX} y={eyeY} width={eyeWidth} height={eyeHeight} rx={eyeWidth / 2} fill="#ffffff" />
        <rect x={rightX} y={eyeY} width={eyeWidth} height={eyeHeight} rx={eyeWidth / 2} fill="#ffffff" />
        {showMouth ? (
          <path
            d={`M${50 - mouthHalfWidth} ${mouthY} Q50 ${mouthY + recipe.mouthCurve} ${50 + mouthHalfWidth} ${mouthY}`}
            fill="none"
            stroke="#ffffff"
            strokeWidth={mouthStroke}
            strokeLinecap="round"
          />
        ) : null}
      </g>
    </svg>
  );
}

export type MausAvatarHandle = CursorAvatarHandle;

export type MausAvatarProps = {
  color: MausColor;
  avatarDefinition?: BotProceduralAvatar | null;
  /** Named behaviour — drives the expression pool, its cadence and blinking. */
  state?: MausState;
  /** Pin one of the 25 faces and stop the state's own drift. */
  expression?: number;
  size?: number;
  label?: string;
  motion?: MausMotion;
  motionKey?: number;
  /** Head turn in degrees. */
  turn?: number;
  gaze?: { x?: number; y?: number };
  spring?: number;
  eyeScale?: number;
  showMouth?: boolean;
  mouthStroke?: number;
  /**
   * Face the viewer at turn 0, cancelling each expression's authored gaze
   * direction. Off restores the engine's own drawn-in directions.
   */
  forward?: boolean;
  /** How much each expression glances around. Overrides `forward`'s 0-or-1. */
  lookAround?: number;
  /** Let the eyes follow the pointer across this avatar. */
  trackPointer?: boolean;
  /** Run the animation. Off renders the state's resting face. */
  animated?: boolean;
  /** Legacy Maus face-placement knobs — accepted, ignored. */
  eyeSpacing?: number;
  faceX?: number;
  faceY?: number;
  faceScale?: number;
};

function MausAvatarComponent(
  {
    color,
    avatarDefinition,
    state = "idle",
    expression,
    size = 44,
    label,
    motion = "none",
    motionKey = 0,
    turn,
    gaze,
    spring,
    eyeScale,
    forward = true,
    lookAround,
    trackPointer = true,
    animated = true,
    showMouth = true,
    mouthStroke = CANONICAL_FACE_CONTRACT.mouthStrokeWidth,
  }: MausAvatarProps,
  ref: React.Ref<MausAvatarHandle>,
) {
  const inner = useRef<CursorAvatarHandle>(null);
  const presentation = proceduralAvatarPresentation(avatarDefinition);
  useImperativeHandle(ref, () => ({
    blink: () => inner.current?.blink(),
    spin: (durationMs?: number) => inner.current?.spin(durationMs),
    setExpression: (index: number) => inner.current?.setExpression(index),
  }));

  // A one-shot motion borrows the state for a moment, then hands it back.
  const [motionState, setMotionState] = useState<MausState | null>(null);
  useEffect(() => {
    if (motion === "none" || !animated) return;
    const beat = MOTION_FACE[motion];
    if (!beat) return;
    if (beat.blink) inner.current?.blink();
    if (beat.spin) inner.current?.spin(beat.spin);
    if (!beat.state) return;
    setMotionState(beat.state);
    const timer = setTimeout(() => setMotionState(null), MOTION_FACE_MS);
    return () => clearTimeout(timer);
  }, [motion, motionKey, animated]);

  // Pointer-follow gaze, composed with any gaze the caller pins.
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const range = forward ? POINTER_GAZE.forward : POINTER_GAZE.authored;
  const onPointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!trackPointer || !animated) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setPointer({
      x: Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1)) * range,
      y: Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1)) * range,
    });
  };
  const onPointerLeave = () => setPointer({ x: 0, y: 0 });
  const renderedState = motionState ?? state;

  return (
    <span
      className="inline-flex shrink-0"
      data-avatar-surface={presentation.surface}
      onPointerMove={trackPointer && animated ? onPointerMove : undefined}
      onPointerLeave={trackPointer && animated ? onPointerLeave : undefined}
    >
      <span className="relative block shrink-0" style={{ width: size, height: size }}>
        <span
          className="absolute inset-0"
          style={{ transform: `scale(${presentation.opticalScale})`, transformOrigin: "center" }}
        >
          <CursorAvatar
            ref={inner}
            state={renderedState}
            expression={expression}
            size={size}
            silhouette={presentation.silhouette}
            gradient={gradientFor(color)}
            title={label ?? null}
            lookAround={lookAround ?? (forward ? 0 : 1)}
            gaze={{ x: (gaze?.x ?? 0) + pointer.x, y: (gaze?.y ?? 0) + pointer.y }}
            turn={turn}
            spring={spring}
            eyeScale={eyeScale}
            showMouth={false}
            eyeColor="transparent"
            paused={!animated}
          />
          <CanonicalFaceRig
            state={renderedState}
            faceScale={presentation.faceScale}
            faceOffset={presentation.faceOffset}
            gaze={{ x: (gaze?.x ?? 0) + pointer.x, y: (gaze?.y ?? 0) + pointer.y }}
            showMouth={showMouth}
            mouthStroke={mouthStroke}
          />
        </span>
      </span>
    </span>
  );
}

export const MausAvatar = memo(forwardRef(MausAvatarComponent));

export type BotAvatarProps = Omit<MausAvatarProps, "color"> & {
  bot: {
    name?: string;
    color: MausColor;
    avatarUrl?: string | null;
    avatarCrop?: BotAvatarCrop;
    avatarDefinition?: BotProceduralAvatar | null;
  };
};

/**
 * The one renderer for a bot's chosen profile image. Malformed persisted
 * values and images that fail to load both fall back to the animated mascot,
 * so an old/corrupt profile can never leave a broken-image icon in the app.
 */
export function BotAvatar({ bot, size = 44, label, ...mascotProps }: BotAvatarProps) {
  const profile = botAvatarProfile(bot);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => setImageFailed(false), [profile.avatarUrl]);

  if (profile.avatarCrop === "mascot" || !profile.avatarUrl || imageFailed) {
    return (
      <MausAvatar
        {...mascotProps}
        color={bot.color}
        avatarDefinition={profile.avatarDefinition}
        size={size}
        label={label ?? bot.name}
      />
    );
  }

  const radius =
    profile.avatarCrop === "circle"
      ? "50%"
      : profile.avatarCrop === "rounded"
        ? "22%"
        : "0";
  return (
    <img
      src={profile.avatarUrl}
      alt={label ?? (bot.name ? `${bot.name} avatar` : "Bot avatar")}
      width={size}
      height={size}
      draggable={false}
      onError={() => setImageFailed(true)}
      className="block shrink-0 bg-raised object-cover"
      style={{ width: size, height: size, borderRadius: radius }}
    />
  );
}

export function InitialsAvatar({
  initials,
  size = 32,
}: {
  initials: string;
  size?: number;
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary font-medium"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials}
    </div>
  );
}
