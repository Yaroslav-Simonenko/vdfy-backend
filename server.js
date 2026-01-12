require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path'); // <--- ДОДАВ ЦЕ

const app = express();
app.use(cors());
app.use(express.json());

// 1. НАЛАШТУВАННЯ FIREBASE (Auth)
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// 2. НАЛАШТУВАННЯ S3 / R2 (Storage)
const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// 3. НАЛАШТУВАННЯ OPENAI (AI)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 4. НАЛАШТУВАННЯ MULTER
const upload = multer({ dest: 'uploads/' });

// ==========================================
// 🛡️ MIDDLEWARE: УНІВЕРСАЛЬНА ПЕРЕВІРКА ТОКЕНА
// ==========================================
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    return next();
  } catch (firebaseError) {
    // Не JWT? Пробуємо Google Access Token
  }

  try {
    const response = await fetch(`https://www.googleapis.com/oauth2/v3/userinfo`, {
        headers: { Authorization: `Bearer ${token}` }
    });

    if (!response.ok) {
        throw new Error('Invalid Google Token');
    }

    const userData = await response.json();
    req.user = {
        uid: userData.sub,
        email: userData.email,
        name: userData.name,
        picture: userData.picture
    };
    return next();

  } catch (error) {
    console.error("Auth Error:", error.message);
    return res.status(403).json({ error: 'Forbidden: Invalid token' });
  }
};

// ==========================================
// 🚀 ROUTES (МАРШРУТИ)
// ==========================================

// 1. Головна сторінка (Health check)
app.get('/', (req, res) => {
  res.send('✅ VDFY Backend is Running (AI + R2 + Dashboard)');
});

// 2. АДМІНКА (ПОВЕРНУВ! 🎉)
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// 3. ЗАВАНТАЖЕННЯ + AI
app.post('/api/upload-with-ai', verifyToken, upload.single('file'), async (req, res) => {
  try {
    console.log(`🎤 Processing file for USER: ${req.user.uid}`);
    
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // Додаємо розширення файлу для OpenAI
    const originalPath = req.file.path;
    const newPath = req.file.path + '.webm';
    fs.renameSync(originalPath, newPath);

    // Транскрипція Whisper
    console.log("🤖 Sending to OpenAI Whisper...");
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(newPath),
      model: "whisper-1",
    });

    // Завантаження в R2
    const fileStream = fs.createReadStream(newPath);
    const folder = req.body.folder || "Unsorted";
    const fileName = `rec_${Date.now()}.webm`;
    const r2Key = `${req.user.uid}/${folder}/${fileName}`;

    const uploadVideoParams = {
      Bucket: process.env.R2_BUCKET_NAME,
      Key: r2Key,
      Body: fileStream,
      ContentType: "video/webm",
    };
    await s3.send(new PutObjectCommand(uploadVideoParams));

    // Зберігаємо текст поруч
    const textKey = r2Key.replace('.webm', '.txt');
    await s3.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: textKey,
        Body: transcription.text,
        ContentType: "text/plain"
    }));

    // Очистка
    fs.unlinkSync(newPath);

    const publicUrl = `${process.env.R2_PUBLIC_URL}/${r2Key}`;
    
    res.json({ 
        success: true, 
        publicUrl: publicUrl,
        transcription: transcription.text
    });

  } catch (error) {
    console.error("❌ Processing Error:", error);
    if (req.file && fs.existsSync(req.file.path + '.webm')) {
        try { fs.unlinkSync(req.file.path + '.webm'); } catch(e){}
    }
    res.status(500).json({ error: "Failed to process video: " + error.message });
  }
});

// ЗАПУСК СЕРВЕРА
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});