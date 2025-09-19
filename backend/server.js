// server.js
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const serverless = require("serverless-http");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const DEFAULT_PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || "change_this_secret";
const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/gamified_ed";

// ---------------- Gemini client ----------------
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });

// ---------------- Mongo Schemas ----------------
const { Schema } = mongoose;

const EmbeddingSchema = new Schema({
  text: String,
  vector: [Number],
  createdAt: { type: Date, default: Date.now },
  source: { type: String, default: "user_profile" },
});

// New Schema for a single question
const QuestionSchema = new Schema({
  questionDescription: { type: String, required: true },
  questionType: { type: String, enum: ["objective", "subjective"], required: true },
  difficulty: { type: String, enum: ["easy", "medium", "hard"], default: "medium" },
  correctAnswer: { type: String, required: true },
  userAnswer: { type: String, required: true },
  isCorrect: { type: Boolean, required: true },
  answeredAt: { type: Date, default: Date.now },
});

const UserSchema = new Schema({
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, trim: true },
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  age: Number,
  standard: String,
  bio: { type: String, default: "" },

  xp: { type: Number, default: 0 },
  gamePoints: { type: Number, default: 0 },
  gamesWon: { type: Number, default: 0 },
  questionsSolved: { type: Number, default: 0 },
  badges: [String],

  school: String,
  subjects: [String],
  avatarUrl: String,

  embeddings: [EmbeddingSchema],
  questions: [QuestionSchema], // Added the new questions array

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
UserSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

const User = mongoose.model("User", UserSchema);

// ---------------- Helpers ----------------
async function createEmbedding(text) {
  try {
    const result = await embeddingModel.embedContent({
      content: { parts: [{ text }] },
    });
    return result.embedding.values;
  } catch (err) {
    console.error("Embedding error:", err);
    return null;
  }
}

function generateToken(user) {
  return jwt.sign(
    { id: user._id, username: user.username, email: user.email },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function authenticateToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Missing token" });
  }
  try {
    req.user = jwt.verify(auth.split(" ")[1], JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}

// ---------------- Express ----------------
const app = express();
app.use(express.json());
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.get("/api/health", (_, res) => res.json({ ok: true }));

// Register
app.post("/api/register", async (req, res) => {
  try {
    const { firstName, lastName, username, email, age, standard, password } =
      req.body;
    if (!firstName || !username || !email || !password) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const exists = await User.findOne({ $or: [{ username }, { email }] });
    if (exists) return res.status(409).json({ message: "User already exists" });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = new User({
      firstName,
      lastName,
      username,
      email,
      passwordHash,
      age,
      standard,
    });

    const profileText = `${firstName} ${lastName || ""} ${username} ${email} ${
      standard || ""
    }`;
    const vector = await createEmbedding(profileText);
    if (vector) user.embeddings.push({ text: profileText, vector, source: "register" });

    await user.save();
    return res
      .status(201)
      .json({
        token: generateToken(user),
        user: { id: user._id, username, email, xp: user.xp },
      });
  } catch (err) {
    console.error("Register error", err);
    res.status(500).json({ message: "Internal error" });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  try {
    const { identifier, password } = req.body;
    const user = await User.findOne({
      $or: [{ username: identifier }, { email: identifier }],
    });
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    res.json({
      token: generateToken(user),
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        xp: user.xp,
      },
    });
  } catch (err) {
    console.error("Login error", err);
    res.status(500).json({ message: "Internal error" });
  }
});

// Profile update
app.put("/api/profile", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "Not found" });

    const { bio, school, subjects, avatarUrl, age, standard } = req.body;
    if (bio !== undefined) user.bio = bio;
    if (school !== undefined) user.school = school;
    if (subjects !== undefined)
      user.subjects = Array.isArray(subjects) ? subjects : [subjects];
    if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;
    if (age !== undefined) user.age = age;
    if (standard !== undefined) user.standard = standard;

    const profileText = [
      user.firstName,
      user.lastName,
      user.username,
      user.email,
      user.bio,
      user.school,
      ...(user.subjects || []),
      user.standard,
    ]
      .filter(Boolean)
      .join(" | ");

    const vector = await createEmbedding(profileText);
    if (vector) {
      user.embeddings.push({ text: profileText, vector, source: "profile_update" });
      if (user.embeddings.length > 8) user.embeddings = user.embeddings.slice(-8);
    }

    await user.save();
    res.json({ message: "Profile updated", xp: user.xp });
  } catch (err) {
    console.error("Profile update error", err);
    res.status(500).json({ message: "Internal error" });
  }
});

// Leaderboard
app.get("/api/leaderboard", async (req, res) => {
  try {
    const users = await User.find()
      .sort({ xp: -1 })
      .select("username xp gamePoints gamesWon")
      .lean();
    res.json(users);
  } catch (err) {
    console.error("Leaderboard error", err);
    res.status(500).json({ message: "Internal error" });
  }
});

// Get current user info
app.get("/api/me", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-passwordHash -__v");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (err) {
    console.error("Get /me error", err);
    res.status(500).json({ message: "Internal error" });
  }
});

// Update any user field
app.put("/api/user", authenticateToken, async (req, res) => {
  try {
    const { questions, ...updates } = req.body;
    const allowedFields = [
      "firstName",
      "lastName",
      "age",
      "standard",
      "bio",
      "school",
      "subjects",
      "avatarUrl",
      "xp",
      "gamePoints",
      "gamesWon",
      "questionsSolved",
      "badges",
    ];

    const updateOperations = {};
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        updateOperations[field] = updates[field];
      }
    }

    // Handle questions field separately using $push
    if (questions) {
      if (!Array.isArray(questions)) {
        return res.status(400).json({ message: "Questions must be an array." });
      }
      if (questions.length > 0) {
        // Use $push to add a new question to the array
        const questionToPush = questions[0];
        // Ensure the question object has all required fields before pushing
        if (!questionToPush.questionDescription || !questionToPush.questionType || !questionToPush.correctAnswer || !questionToPush.userAnswer || questionToPush.isCorrect === undefined) {
          return res.status(400).json({ message: "Invalid question object. Missing required fields." });
        }
        updateOperations.$push = { questions: questionToPush };
      }
    }

    if (Object.keys(updateOperations).length === 0) {
      return res.status(400).json({ message: "No valid fields provided for update" });
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { ...updateOperations, updatedAt: Date.now() },
      { new: true, runValidators: true }
    ).select("-passwordHash -__v");

    if (!user) return res.status(404).json({ message: "User not found" });

    res.json({ message: "User updated successfully", user });
  } catch (err) {
    console.error("Update /user error", err);
    res.status(500).json({ message: "Internal error" });
  }
});

// ---------------- Start ----------------
mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("MongoDB connected");

    if (require.main === module) {
      // Normal express mode
      app.listen(DEFAULT_PORT, () =>
        console.log(`Server running at http://localhost:${DEFAULT_PORT}`)
      );
    }
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
  });

module.exports = { handler: serverless(app) };