import express from "express";
import session from "express-session";
import bcrypt from "bcrypt";
import multer from "multer";
import { createRequire } from "module"; // for pdf-parse
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

// --- Supabase Client ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// --- Session ---
app.use(
  session({
    secret: process.env.SESSION_SECRET || "secret",
    resave: false,
    saveUninitialized: false,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Serve static files (but don't auto-serve index.html) ---
app.use(express.static("public", { index: false }));

// --- Multer setup ---
const upload = multer({ dest: "uploads/" });

// --- Google Gemini ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

// --- Middleware for auth ---
function isAuth(req, res, next) {
  if (req.session.user) return next();
  res.redirect("/login.html");
}

// --- Root route -> always login page ---
app.get("/", (req, res) => {
  res.redirect("/login.html");
});

// --- Protected route for index.html ---
app.get("/index.html", isAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- REGISTER ---
app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.json({ success: false, message: "Username and password required" });

  try {
    const hashed = await bcrypt.hash(password, 10);
    const { error } = await supabase
      .from("users")
      .insert([{ username, password: hashed }]);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "User already exists or DB error" });
  }
});

// --- LOGIN ---
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.json({ success: false, message: "Username and password required" });

  try {
    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("username", username)
      .single();
    if (error || !data) return res.json({ success: false, message: "User not found" });

    const valid = await bcrypt.compare(password, data.password);
    if (!valid) return res.json({ success: false, message: "Invalid password" });

    req.session.user = { id: data.id, username: data.username };
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Login failed" });
  }
});

// --- LOGOUT ---
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login.html");
  });
});

// --- UPLOAD & ANALYSIS ---
app.post("/upload", isAuth, upload.single("resume"), async (req, res) => {
  try {
    if (!req.file) {
      return res.json({ success: false, message: "No file uploaded" });
    }

    let resumeText = "";

    // Parse resume
    if (req.file.mimetype === "application/pdf") {
      const dataBuffer = fs.readFileSync(req.file.path);
      const data = await pdfParse(dataBuffer);
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

    // 🔥 STRICT JSON PROMPT
    const prompt = `
You are a professional ATS (Applicant Tracking System).

Analyze the resume text provided.

RULES:
- Respond ONLY in valid JSON
- No markdown
- No explanations outside JSON
- Follow the schema strictly

Resume Text:
${resumeText}

${jobDesc ? `Job Description:\n${jobDesc}` : ""}

JSON RESPONSE SCHEMA:

If mode = resume_only:
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

If mode = resume_jd:
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

Mode to use: ${mode}
`;

    const result = await model.generateContent(prompt);
    const rawText = result.response.text();

    // 🛡️ Safety JSON parse
    let analysis;
    try {
      analysis = JSON.parse(rawText);
    } catch (err) {
      console.error("❌ JSON parse error:", rawText);
      return res.json({
        success: false,
        message: "AI response format error. Try again."
      });
    }

    res.json({
      success: true,
      analysis
    });

  } catch (err) {
    console.error("❌ Resume analysis error:", err);
    res.json({ success: false, message: "Analysis failed" });
  }
});


// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
