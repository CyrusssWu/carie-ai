# Carie AI

A career-exploration web app (PWA) for Hong Kong secondary school students. Students try short, AI-written job simulations, reflect on how the work felt, and keep a Career Passport they can choose to share with a mentor.

Live site: https://carieai.netlify.app

## What's here

| Path | What it is |
| --- | --- |
| `index.html` | The whole app (vanilla JavaScript, no build step) |
| `i18n.js` | English → Traditional Chinese (Hong Kong) interface text |
| `config.js` | Supabase project URL and publishable key (public by design) |
| `sw.js`, `manifest.webmanifest`, icons | Offline cache and home-screen install |
| `images/` | Welcome and industry pictures |
| `supabase/` | Database SQL and the `ai` Edge Function (Google AI Studio + BytePlus Seedream) |
| `make-publish.ps1` | Builds the `publish/` folder and `carie-ai-site.zip` for Netlify |

## Setup

- Cloud database, sign-in and AI: see [SETUP.md](SETUP.md).
- Installing on iPhone: see [README-iphone.md](README-iphone.md).

API keys (Gemini, BytePlus, Resend) live only in Supabase secrets and are never stored in this repository.
