require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const OpenAI = require('openai');

// 👇 1. Підключаємо Firebase Admin SDK
const admin = require('firebase-admin');

// 👇 2. РОЗУМНЕ ЗАВАНТАЖЕННЯ КЛЮЧА (FIX ДЛЯ RAILWAY & GIT)
let serviceAccount;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Варіант А: Ми на Railway (беремо зі змінної)
    console.log("🔑 Loading Firebase creds from ENV variable...");
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    // Варіант Б: Ми локально (беремо з файлу)
    console.log("📂 Loading Firebase creds from local file...");
    serviceAccount = require('./serviceAccountKey.json');
  }
} catch (error) {
  console.error("❌ CRITICAL ERROR: Could not load Firebase credentials!");
  console.error("Make sure you set FIREBASE_SERVICE_ACCOUNT in Railway Variables or have serviceAccountKey.json locally.");
  console.error(error);
  process.exit(1); // Зупиняємо сервер, бо без ключів він не працюватиме
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

// Підключення до Cloudflare R2
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 👇 3. СТВОРЮЄМО ОХОРОНЦЯ (Middleware)
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken; 
    // console.log(`👤 User verified: ${req.user.uid}`);
    next();
  } catch (error) {
    console.error('Auth Error:', error);
    return res.status(403).json({ error: 'Forbidden: Invalid token' });
  }
};

// === ЗАХИЩЕНИЙ МАРШРУТ (Upload) ===
app.post('/api/upload-with-ai', verifyToken, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const folder = req.body.folder || "Unsorted";
    const userId = req.user.uid; 
    
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    console.log(`🎤 Processing file for USER: ${userId}`);

    // --- Транскрибація (Whisper) ---
    let transcriptionText = "";
    try {
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(file.path),
          model: "whisper-1",
          response_format: "text",
        });
        transcriptionText = transcription;
    } catch (aiError) {
        console.error("AI Error:", aiError);
        transcriptionText = "[Transcription failed]";
    }

    // --- Збереження в R2 ---
    const fileNameBase = file.originalname.replace('.webm', '');
    const videoKey = `${userId}/${folder}/${fileNameBase}.webm`;
    const textKey = `${userId}/${folder}/${fileNameBase}.txt`;

    const fileStream = fs.readFileSync(file.path);

    // Завантажуємо відео
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: videoKey,
      Body: fileStream,
      ContentType: file.mimetype,
    }));

    // Завантажуємо текст
    await s3.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: textKey,
        Body: transcriptionText,
        ContentType: 'text/plain',
    }));

    fs.unlinkSync(file.path);

    const publicUrl = `${process.env.R2_PUBLIC_URL}/${videoKey}`;
    
    res.json({ publicUrl, transcription: transcriptionText });

  } catch (error) {
    console.error("Upload Error:", error);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Server error' });
  }
});

// === ЗАХИЩЕНИЙ СПИСОК (List Videos) ===
app.get('/api/videos', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    
    const command = new ListObjectsV2Command({ 
        Bucket: process.env.R2_BUCKET_NAME,
        Prefix: `${userId}/`
    });
    const data = await s3.send(command);
    
    const structure = {};
    
    (data.Contents || []).forEach(file => {
        if (file.Key.endsWith('.txt')) return;

        const parts = file.Key.split('/');
        if (parts.length < 3) return; 

        const folderName = parts[1];
        
        if (!structure[folderName]) structure[folderName] = [];
        
        structure[folderName].push({
            key: file.Key,
            size: file.Size,
            lastModified: file.LastModified,
            url: `${process.env.R2_PUBLIC_URL}/${file.Key}`
        });
    });

    res.json(structure);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'List error' });
  }
});

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));