/**
 * Status palette (dataviz reference palette, fixed — deliberately not themed):
 * reserved for operational state, distinct from the categorical scene colors,
 * and always paired with a glyph or label so color never carries meaning
 * alone. `error` uses the palette's critical step; `offline` has no reserved
 * hue — it renders dimmed in the theme's muted ink instead.
 */
export const STATUS_COLORS = {
  good: "#0ca30c",
  warning: "#fab219",
  error: "#d03b3b",
} as const;

/** Badge glyph ink on top of the status fills (also fixed). */
export const STATUS_GLYPH_INK = {
  warning: "#1c1b19",
  error: "#ffffff",
} as const;
