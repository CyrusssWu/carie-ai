# Carie AI — cloud setup

The app is a static PWA. Cloud features use **Supabase** (database + email sign-in + an Edge Function that calls Google AI Studio and BytePlus Seedream). Until `config.js` is filled in, the app runs in **local mode**: accounts and passports stay in the browser, emails are not verified, and AI search / AI images are off.

## 1. Create the database

1. Create a project at https://supabase.com.
2. Open **SQL Editor** and run, in order: `supabase/schema.sql`, `supabase/scene_images.sql` (saved story pictures) and `supabase/role_stories.sql` (saved AI-written stories and the student name update).
3. In **Authentication → Providers**, make sure **Email** is enabled.
4. In **Authentication → Email Templates → Magic Link**, include the code so students can type it into the app (links opened from Mail don't open the home-screen app on iPhone), for example:

   ```html
   <h2>Your Carie AI code</h2>
   <p>Enter this code in the app: <strong>{{ .Token }}</strong></p>
   ```

5. For real use, set up custom SMTP (**Authentication → SMTP Settings**). Supabase's built-in mailer only sends a few emails per hour.

## 2. Connect the app

Copy **Project URL** and the **anon public key** from **Project Settings → API** into `config.js`:

```js
window.CARIE_CONFIG = {
  supabaseUrl: "https://YOUR-PROJECT.supabase.co",
  supabaseAnonKey: "eyJ..."
};
```

The anon key is meant to be public. Row-level security in `schema.sql` enforces who can read what.

## 3. Deploy the AI function (Google AI Studio search + BytePlus Seedream 4.5 images)

Get a Gemini API key from Google AI Studio (https://aistudio.google.com/apikey) and a BytePlus ModelArk API key (https://console.byteplus.com/ark) with **seedream-4-5-251128 activated** in the Ark Console. Install the Supabase CLI, then from this folder:

```bash
supabase login
```

```bash
supabase link --project-ref YOUR-PROJECT-REF
```

```bash
supabase secrets set GEMINI_API_KEY=your-ai-studio-key
```

```bash
supabase secrets set ARK_API_KEY=your-byteplus-key
```

```bash
supabase functions deploy ai
```

Optional secrets (defaults shown):

| Secret | Default | Used for |
| --- | --- | --- |
| `GEMINI_MODEL` | `gemini-flash-latest` | AI search on the field selection pages (Google AI Studio) |
| `ARK_IMAGE_MODEL` | `seedream-4-5-251128` | Story images in the job simulation (Seedream 4.5, 2304×1728) |
| `ARK_BASE_URL` | `https://ark.ap-southeast.bytepluses.com/api/v3` | BytePlus region endpoint |

After every deploy, check **Edge Functions → ai → Settings** and make sure **Verify JWT with legacy secret** is **off** (a dashboard redeploy can turn it back on; CLI deploys read `supabase/config.toml`). The function checks sign-in itself.

Search only needs `GEMINI_API_KEY`; story images only need `ARK_API_KEY`. Both keys live only in Supabase secrets — never put them in `config.js` or `index.html`.

## 4. Google sign-in ("Continue with Google")

1. In Google Cloud Console (Google Auth Platform), create a **Web application** OAuth client.
   - Authorised JavaScript origins: your app address (e.g. `http://localhost:5173` and your real site).
   - Authorised redirect URI: `https://YOUR-PROJECT.supabase.co/auth/v1/callback` (copy it from Supabase → Authentication → Sign In / Providers → Google).
   - While the consent screen is in **Testing**, only accounts listed under **Audience → Test users** can sign in; **Publish app** for everyone.
2. In Supabase → Authentication → Sign In / Providers → **Google**: switch **Enable Sign in with Google** on, paste the Client ID and Client secret, **Save**.
3. Add your app address to Authentication → URL Configuration → **Redirect URLs** (e.g. `http://localhost:5173/**`).
4. Run `supabase/google_signin.sql`. New Google accounts start as students; if "Mentor" was chosen before tapping the button, the app upgrades the new account once.

If Google shows **redirect_uri_mismatch**, the redirect URI in step 1 doesn't exactly match Supabase's callback URL.

## Who can see what

- **Students** own their Career Passport. In the **Mentor** tab they switch on any of: field & story, skills, story decisions, reflection & energy, or a check-in request.
- **Mentors** only see students who switched something on, and only those sections (enforced in the database by `shared_students()`). Mentors build **study plans** and offer **pathways**; students see them in their Mentor tab and can tick plan tasks done.
- Plan and pathway creation is mentor-only. The student app no longer has Plan or Pathways tabs.

## Before using with real students

- Anyone can currently register as a mentor. Add a mentor approval step (for example an `approved` column checked in `is_mentor()`) before real student data is stored.
- Add rate limits or a usage budget for the `ai` function; each story image is a paid BytePlus Seedream call.
- Review your school/NGO's data-protection requirements (Hong Kong PDPO) and get guardian consent where needed.
