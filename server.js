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
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

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
    if (!req.file) return res.json({ success: false, message: "No file uploaded" });

    let text = "";
    if (req.file.mimetype === "application/pdf") {
      const dataBuffer = fs.readFileSync(req.file.path);
      const data = await pdfParse(dataBuffer);
      text = data.text;
    } else if (
      req.file.mimetype ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const data = await mammoth.extractRawText({ path: req.file.path });
      text = data.value;
    } else {
      return res.json({ success: false, message: "Unsupported file format" });
    }

    // Delete temp file
    fs.unlinkSync(req.file.path);

    const jobDesc = req.body.jobdesc || "";

    const prompt = `
You are an ATS + Resume analyzer.
Analyze the following resume:
${text}

Job Description (optional):
${jobDesc}

Provide:
- Overall score (0-100)
- Keyword match rate
- Missing keywords
- Technical skills
- Experience level
- Grammar quality score
- Actionable improvement recommendations
    `;

    const result = await model.generateContent(prompt);
    const output = result.response.text();

    res.json({ success: true, analysis: output });
  } catch (err) {
    console.error("❌ Resume parsing error:", err);
    res.json({ success: false, message: "Analysis failed" });
  }
});

// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
