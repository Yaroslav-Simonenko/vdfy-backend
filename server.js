require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
// 👇 ДОДАВ ListObjectsV2Command ДЛЯ ЧИТАННЯ СПИСКУ
const { S3Client, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// 1. FIREBASE AUTH
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// 2. R2 STORAGE
const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// 3. OPENAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 4. MULTER
const upload = multer({ dest: 'uploads/' });

// --- MIDDLEWARE AUTH ---
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    return next();
  } catch (e) {}

  try {
    const response = await fetch(`https://www.googleapis.com/oauth2/v3/userinfo`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) throw new Error('Invalid Google Token');
    const userData = await response.json();
    req.user = { uid: userData.sub, email: userData.email, name: userData.name, picture: userData.picture };
    return next();
  } catch (error) {
    return res.status(403).json({ error: 'Forbidden' });
  }
};

// ================= ROUTES =================

app.get('/', (req, res) => res.send('✅ VDFY Backend Ready'));

// 1. АДМІНКА (ПОВЕРНУВ!)
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// 2. ЗАВАНТАЖЕННЯ ВІДЕО (+ AI)
app.post('/api/upload-with-ai', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });

    // Rename for OpenAI
    const newPath = req.file.path + '.webm';
    fs.renameSync(req.file.path, newPath);

    // Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(newPath),
      model: "whisper-1",
    });

    // Upload Video to R2
    const fileStream = fs.createReadStream(newPath);
    const folder = req.body.folder || "Unsorted";
    const fileName = `rec_${Date.now()}.webm`;
    const r2Key = `${req.user.uid}/${folder}/${fileName}`;

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: r2Key,
      Body: fileStream,
      ContentType: "video/webm",
    }));

    // Upload Text to R2
    const textKey = r2Key.replace('.webm', '.txt');
    await s3.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: textKey,
        Body: transcription.text,
        ContentType: "text/plain"
    }));

    fs.unlinkSync(newPath);

    res.json({ 
        success: true, 
        publicUrl: `${process.env.R2_PUBLIC_URL}/${r2Key}`,
        transcription: transcription.text
    });

  } catch (error) {
    console.error(error);
    if (req.file && fs.existsSync(req.file.path + '.webm')) fs.unlinkSync(req.file.path + '.webm');
    res.status(500).json({ error: error.message });
  }
});

// 3. ОТРИМАННЯ СПИСКУ ВІДЕО (ОСЬ ЦЕ БУЛО ВИДАЛЕНО!)
app.get('/api/my-videos', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        // Шукаємо файли в папці користувача
        const command = new ListObjectsV2Command({
            Bucket: process.env.R2_BUCKET_NAME,
            Prefix: `${userId}/`
        });

        const data = await s3.send(command);
        
        // Якщо файлів немає
        if (!data.Contents) return res.json({ videos: [] });

        // Формуємо красивий список
        // Фільтруємо тільки .webm (відео)
        const videos = data.Contents
            .filter(item => item.Key.endsWith('.webm'))
            .map(item => ({
                key: item.Key,
                url: `${process.env.R2_PUBLIC_URL}/${item.Key}`,
                uploadedAt: item.LastModified
            }));

        res.json({ videos });
    } catch (error) {
        console.error("List Error:", error);
        res.status(500).json({ error: "Failed to list videos" });
    }
});

// === ФІНАЛЬНИЙ ЗАПУСК НА ПОРТУ 3000 ===
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 FINAL FIX: Server is listening on 0.0.0.0:${PORT}`);
});