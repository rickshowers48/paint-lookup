# PaintMatchPen — Brand Asset Kit

Generated 24 SVGs + 114 PNGs + 7 favicon sizes.
All SVGs use outlined Archivo Black glyphs — no font dependencies. Open in any
browser, illustrator, or place directly on the web. Every asset renders
identically everywhere, forever.

## Folder structure

    public/brand/
      svg/               — vector master files (use these everywhere possible)
      png/               — rasters at multiple sizes for wherever SVG isn't supported
      favicon.ico        — multi-size favicon for the website

## Naming convention

    pmp-{layout}-{variant}[-{width}].{ext}

    layout:  horizontal | stacked | wordmark | mark
    variant: primary | primary-transparent
           | inverted | inverted-transparent
           | mono-white | mono-black

## Layouts

    horizontal  — the main "PaintMatch|PEN" lockup, wide (~7:1)
                  → website banner, header, print catch-all
    stacked     — text on top, chip+PEN below, square-ish (~2:1)
                  → social profile, avatar, tall spaces
    wordmark    — just "PaintMatch" (no chip, no PEN block)
                  → compact places where the mark is too fussy
    mark        — just chip + PEN block (no wordmark)
                  → favicons, app icons, decorative touches, watermarks

## Colour variants

    primary                — white text on black background (main brand look)
    primary-transparent    — same, no background (place on your black hero)
    inverted               — dark text on white background (light-mode use)
    inverted-transparent   — same, no background (place on white pages)
    mono-white             — solid white, chip transparent (over photos)
    mono-black             — solid black (single-colour print, stamps)

## PNG sizes

    horizontal / stacked : 400 / 800 / 1200 / 1600 / 2400 px wide
    wordmark             : 400 / 800 / 1200 / 1600 px wide
    mark                 : 128 / 256 / 512 / 1024 / 2048 px square
    favicon              : 16 / 32 / 48 / 64 / 180 / 192 / 512 px

## Fonts

Archivo Black by Omnibus-Type — glyphs outlined to SVG paths, no font install
required. If you edit the SVGs and want to keep the type editable in Illustrator
etc, install Archivo Black locally (free): https://fonts.google.com/specimen/Archivo+Black

## Colours

    Brand black       #0A0A0A
    Brand white       #FFFFFF
    UK chip blue      #012169
    UK chip red       #C8102E
    UK letters yellow #FFCC00
    Rainbow tagline gradient (locked, not part of this kit):
      #FF6B6B → #FF9F45 → #FFD93D → #6BCB77 → #4D96FF → #9B5DE5 → #F15BB5

## Do not

    - Recolour or restyle
    - Squash, stretch, or rotate
    - Recreate the mark by hand — use the SVG/PNG files provided
    - Convert to raster only when print/software demands (SVG > PNG everywhere)
