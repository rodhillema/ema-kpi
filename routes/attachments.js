const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Multer: store in memory for streaming to Cloudinary
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed. Use PNG, JPEG, GIF, WebP, or PDF.'));
    }
  }
});

// POST /api/upload — upload file to Cloudinary (public, used during submission)
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: 'ema-tickets',
          resource_type: 'auto'
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    res.json({
      cloudinaryUrl: result.secure_url,
      publicId: result.public_id,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size
    });
  } catch (err) {
    console.error('Error uploading file:', err);
    res.status(500).json({ error: err.message || 'Failed to upload file' });
  }
});

// POST /api/upload/ticket/:id — save attachment record to existing ticket (admin)
router.post('/ticket/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { cloudinaryUrl, publicId, filename, mimeType, sizeBytes, uploadedBy } = req.body;

    if (!cloudinaryUrl || !publicId || !filename || !uploadedBy) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { rows } = await pool.query(`
      INSERT INTO "TicketAttachment"
        ("ticketId", "cloudinaryUrl", "publicId", "filename", "mimeType", "sizeBytes", "uploadedBy")
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `, [id, cloudinaryUrl, publicId, filename, mimeType || null, sizeBytes || null, uploadedBy]);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error saving attachment:', err);
    res.status(500).json({ error: 'Failed to save attachment' });
  }
});

module.exports = router;
