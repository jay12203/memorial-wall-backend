// Memorial Wall Backend 
// (Cloudinary Storage + SQLite Metadata + SSE)

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const sqlite3 = require("sqlite3").verbose();
const cloudinary = require("cloudinary").v2;

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------
// Settings (.env)
// ---------------------------
const PORT = parseInt(process.env.PORT || "3000", 10);
const ADMIN_KEY = process.env.ADMIN_KEY || "12345";
const MAX_PHOTOS = parseInt(process.env.MAX_PHOTOS || "10000", 10);

// ---------------------------
// Cloudinary config
// ---------------------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ---------------------------
// SQLite setup
// ---------------------------
const DB_PATH = "./photos.db";
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      publicId TEXT NOT NULL,
      url TEXT NOT NULL,
      thumbnailUrl TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_photos_createdAt ON photos(createdAt)`);
});

// ---------------------------
// Multer (memory storage) - because we upload to Cloudinary directly
// ---------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only images (jpeg/png/webp) are allowed"));
    }
    cb(null, true);
  },
});

// ---------------------------
// SSE (Server-Sent Events) for live wall updates
// ---------------------------
const sseClients = new Set();

function sseSend(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

// ---------------------------
// Helpers
// ---------------------------
function enforceMaxPhotos() {
  // Delete anything beyond MAX_PHOTOS (oldest ones)
  db.all(
    `
    SELECT id, publicId
    FROM photos
    ORDER BY datetime(createdAt) DESC
    LIMIT ? OFFSET ?
    `,
    [1000000, MAX_PHOTOS],
    (err, rows) => {
      if (err || !rows || rows.length === 0) return;

      // delete from cloudinary + db
      const ids = rows.map((r) => r.id);
      const publicIds = rows.map((r) => r.publicId);

      // delete images in Cloudinary (best effort)
      publicIds.forEach((pid) => {
        cloudinary.uploader.destroy(pid).catch(() => {});
      });

      const placeholders = ids.map(() => "?").join(",");
      db.run(`DELETE FROM photos WHERE id IN (${placeholders})`, ids);
    }
  );
}

function makeThumbnailUrl(publicId) {
  // Cloudinary transformation URL (fast thumbnail)
  // width 250, auto crop, auto quality/format
  return cloudinary.url(publicId, {
    secure: true,
    transformation: [
      { width: 250, height: 250, crop: "fill" },
      { fetch_format: "auto", quality: "auto" },
    ],
  });
}

// ---------------------------
// Routes
// ---------------------------

app.get("/", (req, res) => {
  res.send("Backend is running");
});

/*
  GET /events  (SSE)
  Wall connects here once, and receives updates instantly when new photos are uploaded/deleted.
*/
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // If you're behind proxies sometimes:
  res.flushHeaders?.();

  sseClients.add(res);

  // Send a hello event
  res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

/*
  GET /photos?limit=800
  Returns latest photos for the wall.
*/
app.get("/photos", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "800", 10), 2000);

  db.all(
    `
    SELECT id, url, thumbnailUrl, createdAt
    FROM photos
    ORDER BY datetime(createdAt) DESC
    LIMIT ?
    `,
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "DB error", error: err.message });
      res.json(rows);
    }
  );
});

  // POST /upload

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const id = uuidv4();
    const createdAt = new Date().toISOString();

    // Cloudinary folder 
    const folder = "memorial_wall";

    // Upload buffer 
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          public_id: id, // use our id as public id for easy management
          resource_type: "image",
          overwrite: true,
        },
        (error, result) => {
          if (error) return reject(error);
          resolve(result);
        }
      );

      stream.end(req.file.buffer);
    });

    const publicId = uploadResult.public_id; // e.g. memorial_wall/<id>
    const url = uploadResult.secure_url;      // https image url
    const thumbnailUrl = makeThumbnailUrl(publicId);

    // Insert into DB
    db.run(
      `INSERT INTO photos (id, publicId, url, thumbnailUrl, createdAt) VALUES (?, ?, ?, ?, ?)`,
      [id, publicId, url, thumbnailUrl, createdAt],
      (err) => {
        if (err) return res.status(500).json({ message: "DB insert error", error: err.message });

        // Cleanup old photos
        enforceMaxPhotos();

        const photo = { id, url, thumbnailUrl, createdAt };

        // Live update for wall
        sseSend({ type: "photo_uploaded", photo });

        return res.json({ message: "Uploaded successfully", photo });
      }
    );
  } catch (error) {
    return res.status(500).json({ message: "Upload failed", error: error.message });
  }
});

/*
  DELETE /photos/:id (Admin only)
  - Requires header: x-admin-key: <ADMIN_KEY>
  - Deletes from Cloudinary and SQLite
*/
app.delete("/photos/:id", (req, res) => {
  const key = req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) return res.status(403).json({ message: "Forbidden (Admin only)" });

  const { id } = req.params;

  db.get(`SELECT publicId FROM photos WHERE id = ?`, [id], async (err, row) => {
    if (err) return res.status(500).json({ message: "DB error", error: err.message });
    if (!row) return res.status(404).json({ message: "Photo not found" });

    // Delete from Cloudinary
    try { await cloudinary.uploader.destroy(row.publicId); } catch {}

    // Delete from DB
    db.run(`DELETE FROM photos WHERE id = ?`, [id], (err2) => {
      if (err2) return res.status(500).json({ message: "DB delete error", error: err2.message });

      // Live update for wall
      sseSend({ type: "photo_deleted", id });

      return res.json({ message: "Photo deleted successfully", id });
    });
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});