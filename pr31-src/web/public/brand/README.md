# Thirdeye AI brand assets

Served from the site root, so anything here has a public URL. Generated deterministically
from one vector master, not from a generative model: the same almond-eye geometry is
rendered at 16px and at 1500px, which is why nothing looks like a different logo.

Palette, unchanged from the brand kit:
- Ink `#0A0C10` background
- Signal amber `#F5A524` the single accent
- Paper `#FEFEFE` mono mark on light surfaces
- Muted `#8A8F98` secondary text (5.6:1 on ink)

## Marks

| File | Use |
| --- | --- |
| `mark.svg` | Primary mark, amber on an ink tile. Anything on a light or unknown surface. |
| `mark-transparent.svg` | Amber on transparent. Over ink, or where the tile would show. |
| `mark-micro.svg` | Reduced geometry (no inner lens echo, thicker stroke). Anything at or below 32px. |
| `mark-mono.svg` | Paper on transparent, single colour. Print, embossing, one-colour contexts. |
| `wordmark.svg`, `wordmark-1600.png` | Horizontal lockup. Docs headers, invoices, email signatures. |

## Cards and banners

| File | Size | Destination |
| --- | --- | --- |
| `og-1200x630.png` (also `/og.png`) | 1200x630 | Link previews: X, Telegram, Discord, Slack, iMessage |
| `x-banner-1500x500.png` | 1500x500 | X profile banner |
| `github-social-1280x640.png` | 1280x640 | GitHub repository social preview |
| `social/x-profile-400.png` | 400x400 | X profile picture |
| `social/telegram-512.png`, `social/discord-512.png` | 512x512 | Group and server icons |
| `social/slack-512.png` | 512x512, transparent | Slack app icon |
| `token-avatar-512.png` | 512x512, no alpha | Token avatar on DEXes, explorers and wallets |

## App icons

| File | Purpose |
| --- | --- |
| `favicon.ico` | 16/32/48 multi-resolution, tab and bookmark fallback |
| `favicon-16x16.png`, `favicon-32x32.png` | Explicit PNG favicons |
| `apple-touch-icon.png` | 180x180, opaque, iOS home screen |
| `icon-192.png`, `icon-512.png` | PWA `any` icons |
| `icon-maskable-512.png` | PWA `maskable`, mark inside the 60% safe circle Android crops to |

## Rules

1. Clear space around the mark equals the height of one inner ring.
2. Never place the amber mark on amber, mid-grey or photography. Ink or paper only.
3. Below 48px use `mark-micro.svg`. The full mark loses its inner lens to anti-aliasing.
4. Do not stretch, outline, shadow or recolour the mark to a second accent. One accent, always.
5. Avatars carry no text. The platform renders the name beside them.

Regenerate with `python3 build.py` in the brand generator (see the conversation workspace); the
SVG masters are the source of truth and the PNGs are disposable.
