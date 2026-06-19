import type { JSX } from "react"

/**
 * One brand glyph per agent provider arc drives, keyed by {@link Provider} kind
 * (plus a few not-yet-in-the-union providers we already have marks for). Each is
 * a single monochrome path that paints with `currentColor`, so a provider mark
 * inherits its row's text colour and sits inline with the Phosphor icons used
 * everywhere else.
 *
 * Paths are vendored (not pulled from the `simple-icons` package, which ships
 * ~3k icons we'd never use) from Simple Icons — except `codex`, which isn't in
 * Simple Icons; that's OpenAI's official monoblossom mark. Each entry carries
 * its own `viewBox` so marks authored on different grids drop in unchanged.
 */
const GLYPHS: Record<string, { readonly viewBox: string; readonly path: string }> = {
  // arc's "claude" provider is the Claude Code CLI — use its hash mark, not the
  // Anthropic starburst.
  claude: {
    viewBox: "0 0 24 24",
    path: "M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z",
  },
  codex: {
    // The blossom only occupies the centre of OpenAI's 721² canvas, so its full
    // viewBox renders ~30% smaller than the edge-to-edge Simple Icons. Crop to the
    // glyph's bounding box (x 118.557–602.696, y 119.958–599.776), squared on the
    // wider axis and centred on the shorter, so it fills the box like the rest.
    viewBox: "118.557 117.798 484.139 484.139",
    path: "M304.246 294.611V249.028C304.246 245.189 305.687 242.309 309.044 240.392L400.692 187.612C413.167 180.415 428.042 177.058 443.394 177.058C500.971 177.058 537.44 221.682 537.44 269.182C537.44 272.54 537.44 276.379 536.959 280.218L441.954 224.558C436.197 221.201 430.437 221.201 424.68 224.558L304.246 294.611ZM518.245 472.145V363.224C518.245 356.505 515.364 351.707 509.608 348.349L389.174 278.296L428.519 255.743C431.877 253.826 434.757 253.826 438.115 255.743L529.762 308.523C556.154 323.879 573.905 356.505 573.905 388.171C573.905 424.636 552.315 458.225 518.245 472.141V472.145ZM275.937 376.182L236.592 353.152C233.235 351.235 231.794 348.354 231.794 344.515V238.956C231.794 187.617 271.139 148.749 324.4 148.749C344.555 148.749 363.264 155.468 379.102 167.463L284.578 222.164C278.822 225.521 275.942 230.319 275.942 237.039V376.186L275.937 376.182ZM360.626 425.122L304.246 393.455V326.283L360.626 294.616L417.002 326.283V393.455L360.626 425.122ZM396.852 570.989C376.698 570.989 357.989 564.27 342.151 552.276L436.674 497.574C442.431 494.217 445.311 489.419 445.311 482.699V343.552L485.138 366.582C488.495 368.499 489.936 371.379 489.936 375.219V480.778C489.936 532.117 450.109 570.985 396.852 570.985V570.989ZM283.134 463.99L191.486 411.211C165.094 395.854 147.343 363.229 147.343 331.562C147.343 294.616 169.415 261.509 203.48 247.593V356.991C203.48 363.71 206.361 368.508 212.117 371.866L332.074 441.437L292.729 463.99C289.372 465.907 286.491 465.907 283.134 463.99ZM277.859 542.68C223.639 542.68 183.813 501.895 183.813 451.514C183.813 447.675 184.294 443.836 184.771 439.997L279.295 494.698C285.051 498.056 290.812 498.056 296.568 494.698L417.002 425.127V470.71C417.002 474.549 415.562 477.429 412.204 479.346L320.557 532.126C308.081 539.323 293.206 542.68 277.854 542.68H277.859ZM396.852 599.776C454.911 599.776 503.37 558.513 514.41 503.812C568.149 489.896 602.696 439.515 602.696 388.176C602.696 354.587 588.303 321.962 562.392 298.45C564.791 288.373 566.231 278.296 566.231 268.224C566.231 199.611 510.571 148.267 446.274 148.267C433.322 148.267 420.846 150.184 408.37 154.505C386.775 133.392 357.026 119.958 324.4 119.958C266.342 119.958 217.883 161.22 206.843 215.921C153.104 229.837 118.557 280.218 118.557 331.557C118.557 365.146 132.95 397.771 158.861 421.283C156.462 431.36 155.022 441.437 155.022 451.51C155.022 520.123 210.682 571.466 274.978 571.466C287.931 571.466 300.407 569.549 312.883 565.228C334.473 586.341 364.222 599.776 396.852 599.776Z",
  },
  cursor: {
    viewBox: "0 0 24 24",
    path: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
  },
  lmstudio: {
    viewBox: "0 0 24 24",
    path: "M5.6 0A5.6 5.6 0 0 0 0 5.6v12.8A5.6 5.6 0 0 0 5.6 24h12.8a5.6 5.6 0 0 0 5.6-5.6V5.6A5.6 5.6 0 0 0 18.4 0zm0 2h12.8A3.6 3.6 0 0 1 22 5.6v12.8a3.6 3.6 0 0 1-3.6 3.6H5.6A3.6 3.6 0 0 1 2 18.4V5.6A3.6 3.6 0 0 1 5.6 2m-.4 2.8a1.2 1.2 0 0 0 0 2.4h10.4a1.2 1.2 0 0 0 0-2.4zm3.2 4a1.2 1.2 0 0 0 0 2.4h10.4a1.2 1.2 0 0 0 0-2.4zm-3.2 4a1.2 1.2 0 0 0 0 2.4h10.4a1.2 1.2 0 0 0 0-2.4zm3.2 4a1.2 1.2 0 0 0 0 2.4h10.4a1.2 1.2 0 0 0 0-2.4z",
  },
  opencode: {
    viewBox: "0 0 24 24",
    path: "M22 24H2V0h20zM17 4.8H7v14.4h10z",
  },
}

/** Provider kinds we ship a brand glyph for; the rest fall through to nothing. */
export const PROVIDERS_WITH_ICON: ReadonlyArray<string> = Object.keys(GLYPHS)

export interface ProviderIconProps {
  /** Provider kind (e.g. "claude", "codex", "cursor"). Unknown kinds render nothing. */
  readonly provider: string
  /** Edge length in px; the glyph is square. Matches Phosphor's `size`. */
  readonly size?: number
  readonly className?: string
  /** Accessible label / tooltip; defaults to the provider kind. */
  readonly title?: string
}

/**
 * A provider's brand mark, sized and coloured like a Phosphor icon (square,
 * `currentColor`). Returns `null` for a provider we have no glyph for, so a
 * caller can render it unconditionally beside an always-present text fallback.
 */
export function ProviderIcon({ provider, size = 16, className, title }: ProviderIconProps): JSX.Element | null {
  const glyph = GLYPHS[provider]
  if (!glyph) return null
  const label = title ?? provider
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={glyph.viewBox}
      fill="currentColor"
      className={className}
    >
      <title>{label}</title>
      <path d={glyph.path} />
    </svg>
  )
}
