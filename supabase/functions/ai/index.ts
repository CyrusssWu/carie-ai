// Carie AI — AI proxy (Supabase Edge Function).
// Keeps API keys on the server, and only answers signed-in users: the caller's
// token is checked against Supabase Auth (works with the new publishable keys,
// so the dashboard's "Verify JWT" setting can stay off).
//
// Secrets (supabase secrets set ...):
//   GEMINI_API_KEY       required for search (Google AI Studio key)
//   GEMINI_MODEL         default "gemini-flash-latest"
//   GEMINI_FALLBACK_MODELS default "gemini-3.5-flash,gemini-flash-lite-latest" (tried when busy or out of quota)
//   ARK_API_KEY          required for story images (BytePlus ModelArk)
//   ARK_IMAGE_MODEL      default "seedream-4-5-251128"  (Seedream 4.5)
//   ARK_BASE_URL         default "https://ark.ap-southeast.bytepluses.com/api/v3"
//
// Story images: Google AI Studio first writes a short picture brief for the
// scenario, Seedream draws it, and the result is saved (scene_images table +
// scene-images bucket, see supabase/scene_images.sql) so each scenario is only
// generated once and every later student gets it instantly.

const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";
const ARK_IMAGE_MODEL = Deno.env.get("ARK_IMAGE_MODEL") ?? "seedream-4-5-251128";
const ARK_BASE_URL = Deno.env.get("ARK_BASE_URL") ?? "https://ark.ap-southeast.bytepluses.com/api/v3";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const clip = (value: unknown, max: number) => String(value ?? "").slice(0, max).trim();

const SEARCH_INSTRUCTIONS = `You are Carie AI, a friendly career-exploration guide for secondary school students in Hong Kong (about Form 3 to S6).
Answer the student's question in plain, encouraging English in under 180 words. Use short paragraphs or a few bullet points.
Explain what the work or study route involves, the skills it uses, and one small, low-cost way to try it.
Never rank the student, diagnose them, or tell them which career to choose. Admission requirements, fees and deadlines change,
so suggest checking those with a school counsellor, teacher or mentor. If the question is about stress, safety or personal
wellbeing, gently suggest talking with a trusted adult or school counsellor instead of giving advice.`;

const BRIEF_INSTRUCTIONS = `You turn one moment from a career-exploration story for Hong Kong secondary students into a picture brief for an illustrator.
Write one paragraph under 90 words describing the setting, the people (age, role, diverse and realistic), exactly what they are doing at this moment, and the mood.
Use concrete visual details only. No readable text, signs, screen contents, logos or brand names. Keep it calm, respectful and suitable for teenagers.
Output only the brief.`;

const PICTURE_STYLE = `A warm, friendly editorial illustration for a career-exploration app for teenagers in Hong Kong.
Soft natural light, muted greens and peach tones, calm and hopeful mood. No text, no words, no logos.`;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
// New projects expose sb_secret_ keys; older ones the legacy service_role JWT.
const SECRET_KEY = (Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"))[0] as string | undefined)
  ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const adminHeaders = () => SECRET_KEY.startsWith("sb_")
  ? { apikey: SECRET_KEY }
  : { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` };

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

async function cachedScene(key: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/scene_images?key=eq.${key}&select=summary,image_url`, { headers: adminHeaders() });
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return rows[0] as { summary: string; image_url: string } | undefined ?? null;
}

// Copies the temporary Seedream picture into the public bucket and records it.
async function saveScene(key: string, summary: string, tempUrl: string) {
  const picture = await fetch(tempUrl);
  if (!picture.ok) throw new Error(`Couldn't download the picture (${picture.status})`);
  const path = `${key}.jpeg`;
  const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/scene-images/${path}`, {
    method: "POST",
    headers: { ...adminHeaders(), "Content-Type": "image/jpeg", "x-upsert": "true" },
    body: await picture.arrayBuffer(),
  });
  if (!upload.ok) throw new Error(`Couldn't save the picture (${upload.status}): ${await upload.text()}`);
  const image_url = `${SUPABASE_URL}/storage/v1/object/public/scene-images/${path}`;
  const insert = await fetch(`${SUPABASE_URL}/rest/v1/scene_images`, {
    method: "POST",
    headers: { ...adminHeaders(), "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key, summary, image_url }),
  });
  if (!insert.ok) throw new Error(`Couldn't record the picture (${insert.status}): ${await insert.text()}`);
  return image_url;
}

async function seedream(prompt: string, key: string) {
  const res = await fetch(`${ARK_BASE_URL}/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ARK_IMAGE_MODEL,
      prompt,
      sequential_image_generation: "disabled",
      response_format: "url",
      size: "2304x1728", // 4:3, within Seedream 4.5's minimum pixel count
      stream: false,
      watermark: false, // the app labels every picture "AI image" itself
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data?.error?.code === "ModelNotOpen") throw new Error("The image model isn't activated in the BytePlus Ark Console yet.");
    throw new Error(data?.error?.message ?? `Image request failed (${res.status})`);
  }
  // Returned URLs expire after about 24 hours; saveScene() keeps a permanent copy.
  return data.data?.[0]?.url as string | undefined;
}

// ---- AI-written job simulations (v0.2) ----
const STORY_INSTRUCTIONS = `You design short, realistic job simulations for Hong Kong secondary students (Form 3 to S6) exploring careers.
Given a job title, first decide whether there is enough reliable, everyday information to simulate that job safely.
If the title is nonsense, too obscure to describe reliably, illegal, sexual, violent or otherwise unsuitable for teenagers, reply:
{"ok": false, "related": [3 x {"title": "a real, suitable related job", "detail": "under 8 words"}]}
Otherwise reply with:
{"ok": true,
 "role": "clean job name, e.g. 'Nursing'",
 "roleTitle": "the student's entry-level role, e.g. 'Junior nurse'",
 "storyTitle": "a short, friendly story title",
 "roleIntro": "one sentence: what people in this job do",
 "setting": "one sentence: the Hong Kong workplace and the challenge in this story",
 "scenarios": [exactly 5 x {
   "label": "2-4 word step label, e.g. 'Listen first'",
   "title": "short scene title",
   "blurb": "2-3 sentences setting up this moment, written to the student as 'you'",
   "question": "the decision the student must make, ending with '?'",
   "options": [exactly 3 x {"title": "what you do, under 10 words", "copy": "the trade-off, under 18 words",
     "outcomeHeading": "'You ...' past-tense recap, under 9 words", "outcome": "1-2 sentences on what happened",
     "skill": "one skill, e.g. Communication", "evidence": "one sentence: what this choice showed"}],
   "help": {"term": "one work word used here", "meaning": "plain-English meaning", "example": "a short example"}
 }]}
The five scenarios must be the most frequent, typical situations in this job, in a sensible order, with honest trade-offs and no single right answer.
Use plain, warm English. No real company names, no medical or legal instructions, nothing frightening. Output JSON only.`;

const SKILLS_INSTRUCTIONS = `You read the path a secondary student took through a short job simulation and name the skills their choices showed.
Return JSON with exactly 5 different skills: {"skills": [5 x {"skill": "skill name", "showed": "1-2 sentences, 'You ...', about what their choices showed",
"involves": "one sentence on how people in this role often use this skill"}]}.
Describe behaviour, never ability or potential. No scores, no rankings, no career advice. Warm, plain English. Output JSON only.`;

const TRANSLATE_INSTRUCTIONS = `You translate text from a career-exploration app for Hong Kong secondary school students.
The input is JSON. Return the same JSON with exactly the same keys, nesting and array lengths, translating every string value.
Keep names, numbers and meaning. Do not add, remove or summarise anything. Output JSON only.`;

function parseJson(text: string) {
  try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return null; }
}

// Keeps only well-formed parts of a generated story so the app can rely on its shape.
function cleanStory(raw: Record<string, unknown>) {
  const s = (v: unknown, max: number) => clip(v, max);
  const scenarios = (Array.isArray(raw.scenarios) ? raw.scenarios : []).slice(0, 5).map((sc: Record<string, unknown>) => ({
    label: s(sc.label, 40), title: s(sc.title, 80), blurb: s(sc.blurb, 500), question: s(sc.question, 200),
    options: (Array.isArray(sc.options) ? sc.options : []).slice(0, 3).map((o: Record<string, unknown>) => ({
      title: s(o.title, 100), copy: s(o.copy, 160), outcomeHeading: s(o.outcomeHeading, 100),
      outcome: s(o.outcome, 400), skill: s(o.skill, 40), evidence: s(o.evidence, 200),
    })),
    help: sc.help && typeof sc.help === "object"
      ? { term: s((sc.help as Record<string, unknown>).term, 40), meaning: s((sc.help as Record<string, unknown>).meaning, 200), example: s((sc.help as Record<string, unknown>).example, 200) }
      : null,
  }));
  const valid = scenarios.length === 5 && scenarios.every((sc) => sc.title && sc.question && sc.options.length === 3 && sc.options.every((o) => o.title && o.outcome));
  if (!valid) return null;
  return { role: s(raw.role, 60), roleTitle: s(raw.roleTitle, 60), storyTitle: s(raw.storyTitle, 80), roleIntro: s(raw.roleIntro, 240), setting: s(raw.setting, 300), scenarios };
}

async function cachedStory(key: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/role_stories?key=eq.${encodeURIComponent(key)}&select=story`, { headers: adminHeaders() });
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return rows[0]?.story ?? null;
}

async function saveStory(key: string, role: string, story: unknown) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/role_stories`, {
    method: "POST",
    headers: { ...adminHeaders(), "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key, role, story }),
  });
  if (!res.ok) console.error("story cache:", res.status, await res.text());
}

async function isSignedIn(req: Request) {
  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return false;
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: req.headers.get("apikey") ?? "" },
  });
  return res.ok;
}

// Each Gemini model has its own free-tier daily quota and its own load, so when one is
// busy (503) or out of quota (429) the next model in the list is tried.
const GEMINI_FALLBACKS = (Deno.env.get("GEMINI_FALLBACK_MODELS") ?? "gemini-3.5-flash,gemini-flash-lite-latest")
  .split(",").map((m) => m.trim()).filter((m) => m && m !== GEMINI_MODEL);
const BUSY_MESSAGE = "Carie AI is very busy right now. Please try again in a little while.";

async function gemini(instructions: string, input: string, key: string, opts: { json?: boolean; maxTokens?: number } = {}) {
  let lastStatus = 0;
  for (const model of [GEMINI_MODEL, ...GEMINI_FALLBACKS]) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instructions }] },
        contents: [{ role: "user", parts: [{ text: input }] }],
        generationConfig: {
          maxOutputTokens: opts.maxTokens ?? 1500,
          ...(opts.json ? { responseMimeType: "application/json" } : {}),
        },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if ([429, 500, 503, 504].includes(res.status)) {
      console.warn(`gemini ${model}: ${res.status} ${String(data?.error?.message ?? "").slice(0, 160)}`);
      lastStatus = res.status;
      continue;
    }
    return readGemini(res, data);
  }
  throw new Error(lastStatus === 429 ? "Carie AI has reached today’s free AI limit. Please try again later." : BUSY_MESSAGE);
}

function readGemini(res: Response, data: Record<string, any>) {
  if (!res.ok) throw new Error(data?.error?.message ?? `Gemini request failed (${res.status})`);
  const candidate = data.candidates?.[0];
  if (!candidate && data.promptFeedback?.blockReason) throw new Error("That question couldn't be answered. Try asking it a different way.");
  return (candidate?.content?.parts ?? [])
    .filter((part: { text?: string; thought?: boolean }) => part.text && !part.thought)
    .map((part: { text: string }) => part.text)
    .join("")
    .trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!(await isSignedIn(req))) return json({ error: "Please sign in to use Carie AI." }, 401);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  // The app's Translation switch asks for Traditional Chinese (Hong Kong) instead of English.
  const zh = body.lang === "zh-HK";
  const inLang = (instructions: string) => zh
    ? `${instructions}\n\nLanguage: write every piece of text meant for the student in Traditional Chinese as used in Hong Kong (繁體中文，香港書面語) instead of English. Keep JSON keys exactly as specified, in English.`
    : instructions;

  try {
    if (body.action === "search") {
      const key = Deno.env.get("GEMINI_API_KEY");
      if (!key) return json({ error: "AI search is not configured (GEMINI_API_KEY missing)." }, 500);
      const query = clip(body.query, 500);
      if (!query) return json({ error: "Type a question first." }, 400);
      const context = [
        body.stage ? `School stage: ${clip(body.stage, 20)}` : "",
        body.field ? `Field they are exploring: ${clip(body.field, 60)}` : "",
      ].filter(Boolean).join("\n");
      const answer = await gemini(inLang(SEARCH_INSTRUCTIONS), context ? `${context}\n\nQuestion: ${query}` : query, key);
      return json({ answer: answer || "Sorry, I couldn't find an answer. Try asking in a different way." });
    }

    if (body.action === "story") {
      const key = Deno.env.get("GEMINI_API_KEY");
      if (!key) return json({ error: "AI stories are not configured (GEMINI_API_KEY missing)." }, 500);
      const role = clip(body.role, 60);
      if (!role) return json({ error: "Type a job first." }, 400);
      const cacheKey = `${GEMINI_MODEL}|${zh ? "zh-HK|" : ""}${role.toLowerCase().replace(/\s+/g, " ")}`;
      const cached = await cachedStory(cacheKey);
      if (cached) return json({ ok: true, story: cached, cached: true });

      const raw = parseJson(await gemini(inLang(STORY_INSTRUCTIONS), `Job title: ${role}`, key, { json: true, maxTokens: 12000 }));
      if (!raw) return json({ error: "Couldn't write this story. Please try again." }, 502);
      if (raw.ok === false) {
        const related = (Array.isArray(raw.related) ? raw.related : []).slice(0, 3)
          .map((r: Record<string, unknown>) => ({ title: clip(r.title, 60), detail: clip(r.detail, 80) })).filter((r) => r.title);
        return json({ ok: false, related });
      }
      const story = cleanStory(raw);
      if (!story) return json({ error: "Couldn't write a complete story. Please try again." }, 502);
      await saveStory(cacheKey, role, story);
      return json({ ok: true, story, cached: false });
    }

    if (body.action === "skills") {
      const key = Deno.env.get("GEMINI_API_KEY");
      if (!key) return json({ error: "AI is not configured (GEMINI_API_KEY missing)." }, 500);
      const role = clip(body.role, 60);
      const path = (Array.isArray(body.path) ? body.path : []).slice(0, 5)
        .map((p: Record<string, unknown>, i: number) => `${i + 1}. ${clip(p.scenario, 100)}: chose "${clip(p.choice, 120)}" -> ${clip(p.outcome, 300)}`).join("\n");
      if (!path) return json({ error: "No story path to read." }, 400);
      const raw = parseJson(await gemini(inLang(SKILLS_INSTRUCTIONS), `Role: ${role}\nPath:\n${path}`, key, { json: true, maxTokens: 4000 }));
      const skills = (Array.isArray(raw?.skills) ? raw.skills : []).slice(0, 5)
        .map((k: Record<string, unknown>) => ({ skill: clip(k.skill, 40), showed: clip(k.showed, 300), involves: clip(k.involves, 240) }))
        .filter((k) => k.skill && k.showed);
      if (!skills.length) return json({ error: "Couldn't read the skills from this story." }, 502);
      return json({ skills });
    }

    // Translates story or passport text the student already has (e.g. a story written in
    // English before they switched to Chinese). Same JSON shape back; cached by content.
    if (body.action === "translate") {
      const key = Deno.env.get("GEMINI_API_KEY");
      if (!key) return json({ error: "AI is not configured (GEMINI_API_KEY missing)." }, 500);
      const to = body.to === "zh-HK" ? "zh-HK" : "en";
      const text = JSON.stringify(body.data ?? null);
      if (!body.data || typeof body.data !== "object" || text.length > 30000) return json({ error: "Nothing to translate." }, 400);
      const cacheKey = `translate|${to}|${await sha256(text)}`;
      const cached = await cachedStory(cacheKey);
      if (cached) return json({ data: cached, cached: true });
      const target = to === "zh-HK" ? "Traditional Chinese as used in Hong Kong (繁體中文，香港書面語)" : "plain, warm English";
      const out = parseJson(await gemini(`${TRANSLATE_INSTRUCTIONS}\nTranslate into ${target}.`, text, key, { json: true, maxTokens: 16000 }));
      if (!out || typeof out !== "object") return json({ error: "Couldn't translate this right now." }, 502);
      await saveStory(cacheKey, "translation", out);
      return json({ data: out, cached: false });
    }

    if (body.action === "image") {
      const arkKey = Deno.env.get("ARK_API_KEY");
      const geminiKey = Deno.env.get("GEMINI_API_KEY");
      if (!arkKey || !geminiKey) return json({ error: "AI images are not configured (ARK_API_KEY and GEMINI_API_KEY are both needed)." }, 500);
      const scene = clip(body.scene, 400);
      const question = clip(body.question, 300);
      if (!question) return json({ error: "Missing question." }, 400);

      const key = await sha256(`${ARK_IMAGE_MODEL}|${scene}|${question}`);
      const cached = await cachedScene(key);
      if (cached) return json({ image: cached.image_url, summary: cached.summary, cached: true });

      // 1. Google AI Studio summarises the scenario into a picture brief.
      // AI-written stories already include a short blurb for each scenario (written by
      // Google AI Studio with the story), so it is used as the brief without another call.
      const blurb = clip(body.brief, 600);
      const summary = blurb || await gemini(BRIEF_INSTRUCTIONS, `Story setting: ${scene}\nThis moment: ${question}`, geminiKey);
      if (!summary) return json({ error: "Couldn't write a picture brief for this scene." }, 502);
      // 2. Seedream draws the brief.
      const tempUrl = await seedream(`${PICTURE_STYLE}\n\n${summary}`, arkKey);
      if (!tempUrl) return json({ error: "No image was returned." }, 502);
      // 3. Keep a permanent copy for every later student; fall back to the temporary link if saving fails.
      try {
        return json({ image: await saveScene(key, summary, tempUrl), summary, cached: false });
      } catch (err) {
        console.error("scene cache:", err instanceof Error ? err.message : err);
        return json({ image: tempUrl, summary, cached: false });
      }
    }

    return json({ error: "Unknown action." }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "AI request failed." }, 502);
  }
});
