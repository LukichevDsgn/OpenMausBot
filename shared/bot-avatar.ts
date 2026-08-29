import { z } from "zod";

/** The mascot is a first-class avatar choice; the other values crop an image. */
export const BOT_AVATAR_CROPS = ["mascot", "circle", "rounded", "square"] as const;
export const botAvatarCropSchema = z.enum(BOT_AVATAR_CROPS);
export type BotAvatarCrop = z.infer<typeof botAvatarCropSchema>;

/**
 * App-authored mascot bodies. Values, rather than SVG, cross the persistence
 * boundary so an avatar can never inject markup into the renderer.
 */
export const BOT_AVATAR_SILHOUETTES = [
  "cursor",
  "orb",
  "tile",
  "gem",
  "pebble",
  "spark",
  "capsule",
  "shield",
  "leaf",
  "moon",
  "hex",
  "drop",
] as const;
export const botProceduralAvatarSchema = z.object({
  version: z.literal(1),
  seed: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  silhouette: z.enum(BOT_AVATAR_SILHOUETTES),
});
export type BotProceduralAvatar = z.infer<typeof botProceduralAvatarSchema>;

/**
 * Custom avatars are deliberately limited to this app's attachment server.
 * Besides making persisted profiles portable across desktop/browser clients,
 * this prevents a bot profile from becoming an external tracking pixel or a
 * script-capable SVG.
 */
export const botAvatarUrlSchema = z
  .string()
  .regex(
    /^\/api\/attachments\/[A-Za-z0-9-]+\.(?:png|jpg|gif|webp)$/,
    "must be a stored PNG, JPEG, GIF, or WebP attachment",
  );

export function botAvatarUrlFromStoredPath(path: string): string | null {
  const name = path.replaceAll("\\", "/").split("/").pop();
  if (!name) return null;
  const url = `/api/attachments/${name}`;
  return botAvatarUrlSchema.safeParse(url).success ? url : null;
}

/** Runtime-safe defaults for untrusted persisted/SSE profile data. */
export interface BotAvatarProfileInput {
  avatarUrl?: unknown;
  avatarCrop?: unknown;
  avatarDefinition?: unknown;
}

export interface BotAvatarProfile {
  avatarUrl?: string;
  avatarCrop: BotAvatarCrop;
  avatarDefinition?: BotProceduralAvatar;
}

export function botAvatarProfile(value: BotAvatarProfileInput): BotAvatarProfile {
  const profile: BotAvatarProfile = {
    avatarCrop: botAvatarCropSchema.safeParse(value.avatarCrop).data ?? "mascot",
  };
  const url = botAvatarUrlSchema.safeParse(value.avatarUrl);
  if (url.success) profile.avatarUrl = url.data;
  const definition = botProceduralAvatarSchema.safeParse(value.avatarDefinition);
  if (definition.success) profile.avatarDefinition = definition.data;
  return profile;
}
