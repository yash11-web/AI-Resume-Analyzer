import express from "express";
import session from "express-session";
import bcrypt from "bcrypt";
import multer from "multer";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");
import mammoth from "mammoth";
import dotenv from "dotenv";
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ================== SUPABASE ================== */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/* ================== SESSION ================== */
app.use(
  session({
    secret: process.env.SESSION_SECRET || "secret",
    resave: false,
    saveUninitialized: true, // REQUIRED for demo users
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ================== STATIC ================== */
app.use(express.static("public", { index: false }));

/* ================== MULTER ================== */
const upload = multer({ dest: "uploads/" });

/* ================== GEMINI ================== */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash-lite",
});

/* ================== DEMO LIMITER ================== */
const DEMO_LIMIT = 3;

function demoLimiter(req, res, next) {
  if (req.session.user) return next();

  if (!req.session.demoCount) {
    req.session.demoCount = 0;
  }

  if (req.session.demoCount >= DEMO_LIMIT) {
    return res.status(401).json({
      success: false,
      demoLimitReached: true,
      message: "Demo limit reached. Please login or signup to continue.",
    });
  }

  req.session.demoCount += 1;
  next();
}

/* ================== ROUTES ================== */

// Entry → demo page
app.get("/", (req, res) => {
  res.redirect("/index.html");
});

// Public demo page
app.get("/index.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ================== REGISTER ================== */
app.post("/register", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.json({ success: false, message: "Username and password required" });
  }

  try {
    const hashed = await bcrypt.hash(password, 10);
    const { error } = await supabase
      .from("users")
      .insert([{ username, password: hashed }]);

    if (error) throw error;
    res.json({ success: true });
  } catch {
    res.json({ success: false, message: "User already exists or DB error" });
  }
});

/* ================== LOGIN ================== */
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("username", username)
    .single();

  if (!data) {
    return res.json({ success: false, message: "User not found" });
  }

  const valid = await bcrypt.compare(password, data.password);
  if (!valid) {
    return res.json({ success: false, message: "Invalid password" });
  }

  req.session.user = { id: data.id, username: data.username };
  req.session.demoCount = 0; // reset demo after login

  res.json({ success: true });
});

/* ================== LOGOUT ================== */
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/index.html");
  });
});
app.get("/demo-status", (req, res) => {
  const remainingTries = req.session.user
    ? null
    : Math.max(
        0,
        DEMO_LIMIT - (req.session.demoCount || 0)
      );

  res.json({
    isDemo: !req.session.user,
    remainingTries,
  });
});


/* ================== UPLOAD & ATS ================== */
app.post(
  "/upload",
  demoLimiter,
  upload.single("resume"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.json({ success: false, message: "No file uploaded" });
      }

      let resumeText = "";

      if (req.file.mimetype === "application/pdf") {
        const buffer = fs.readFileSync(req.file.path);
        const data = await pdfParse(buffer);
        resumeText = data.text;
      } else if (
        req.file.mimetype ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ) {
        const data = await mammoth.extractRawText({ path: req.file.path });
        resumeText = data.value;
      } else {
        return res.json({ success: false, message: "Unsupported file format" });
      }

      fs.unlinkSync(req.file.path);

      const jobDesc = (req.body.jobdesc || "").trim();
      const mode = jobDesc ? "resume_jd" : "resume_only";

      /* ========== GEMINI PROMPT (HARDENED) ========== */
      const prompt = `
You are an ATS system.

CRITICAL RULES:
- Output ONLY valid JSON
- No markdown
- No explanations
- JSON must start with { and end with }

Resume:
${resumeText}

${jobDesc ? `Job Description:\n${jobDesc}` : ""}

If resume_only:
{
  "mode": "resume_only",
  "ats_score": number,
  "strengths": [string],
  "weaknesses": [string],
  "enhancements": [string],
  "section_feedback": {
    "skills": string,
    "projects": string,
    "experience": string,
    "education": string
  }
}

If resume_jd:
{
  "mode": "resume_jd",
  "ats_score": number,
  "keyword_match": number,
  "matched_keywords": [string],
  "missing_keywords": [string],
  "strengths": [string],
  "weaknesses": [string],
  "enhancements": [string],
  "section_feedback": {
    "skills": string,
    "projects": string,
    "experience": string,
    "education": string
  }
}

Mode: ${mode}
`;

      const aiResult = await model.generateContent(prompt);
      const rawText = aiResult.response.text();

      /* ========== SAFE JSON EXTRACTION ========== */
      let jsonText = rawText.trim();

      if (jsonText.startsWith("```")) {
        jsonText = jsonText.replace(/```json|```/g, "").trim();
      }

      const firstBrace = jsonText.indexOf("{");
      const lastBrace = jsonText.lastIndexOf("}");

      if (firstBrace !== -1 && lastBrace !== -1) {
        jsonText = jsonText.substring(firstBrace, lastBrace + 1);
      }

      let analysis;
      try {
        analysis = JSON.parse(jsonText);
      } catch (err) {
        console.error("❌ RAW GEMINI OUTPUT:\n", rawText);
        return res.json({
          success: false,
          message: "AI response format error. Please retry.",
        });
      }

      const remainingTries = req.session.user
        ? null
        : Math.max(0, DEMO_LIMIT - req.session.demoCount);

      res.json({
        success: true,
        analysis,
        remainingTries,
      });
    } catch (err) {
      console.error("❌ ATS ERROR:", err);
      res.json({ success: false, message: "Analysis failed" });
    }
  }
);

/* ================== START ================== */
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
