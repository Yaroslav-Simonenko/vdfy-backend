require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// 1. НАЛАШТУВАННЯ FIREBASE (Auth)
// Якщо змінна середовища є, використовуємо її (для Railway)
// Якщо ні - шукаємо локальний файл (для тестів)
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

// 4. НАЛАШТУВАННЯ MULTER (Завантаження файлів)
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

  // Спроба 1: Перевіряємо як Firebase ID Token (JWT)
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    return next();
  } catch (firebaseError) {
    // Не JWT? Не страшно. Йдемо далі.
  }

  // Спроба 2: Перевіряємо як Google Access Token (Chrome Extension)
  try {
    const response = await fetch(`https://www.googleapis.com/oauth2/v3/userinfo`, {
        headers: { Authorization: `Bearer ${token}` }
    });

    if (!response.ok) {
        throw new Error('Invalid Google Token');
    }

    const userData = await response.json();
    
    // Емулюємо користувача Firebase
    req.user = {
        uid: userData.sub, // Google ID
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

// Перевірка життя сервера
app.get('/', (req, res) => {
  res.send('✅ VDFY Backend is Running (AI + R2 + Universal Auth)');
});

// ГОЛОВНИЙ МАРШРУТ: Завантаження + Транскрипція
app.post('/api/upload-with-ai', verifyToken, upload.single('file'), async (req, res) => {
  try {
    console.log(`🎤 Processing file for USER: ${req.user.uid}`);
    
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // --- КРОК 1: ПІДГОТОВКА ФАЙЛУ (AI FIX) ---
    // OpenAI вимагає розширення файлу. Multer його не дає.
    // Тому ми вручну додаємо .webm до імені.
    const originalPath = req.file.path;
    const newPath = req.file.path + '.webm';
    fs.renameSync(originalPath, newPath);

    // --- КРОК 2: AI ТРАНСКРИПЦІЯ (WHISPER) ---
    console.log("🤖 Sending to OpenAI Whisper...");
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(newPath),
      model: "whisper-1",
    });
    console.log("✅ Transcription done.");

    // --- КРОК 3: ЗАВАНТАЖЕННЯ В R2 (CLOUD) ---
    const fileStream = fs.createReadStream(newPath);
    const folder = req.body.folder || "Unsorted";
    const fileName = `rec_${Date.now()}.webm`;
    const r2Key = `${req.user.uid}/${folder}/${fileName}`;

    console.log("☁️ Uploading video to R2...");
    const uploadVideoParams = {
      Bucket: process.env.R2_BUCKET_NAME,
      Key: r2Key,
      Body: fileStream,
      ContentType: "video/webm",
    };
    await s3.send(new PutObjectCommand(uploadVideoParams));

    // --- КРОК 4: ЗАВАНТАЖЕННЯ ТЕКСТУ В R2 ---
    const textKey = r2Key.replace('.webm', '.txt');
    console.log("📝 Uploading text to R2...");
    await s3.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: textKey,
        Body: transcription.text,
        ContentType: "text/plain"
    }));

    // --- КРОК 5: ОЧИСТКА ---
    fs.unlinkSync(newPath); // Видаляємо тимчасовий файл з сервера

    // --- ФІНІШ ---
    const publicUrl = `${process.env.R2_PUBLIC_URL}/${r2Key}`;
    
    res.json({ 
        success: true, 
        publicUrl: publicUrl,
        transcription: transcription.text
    });

  } catch (error) {
    console.error("❌ Processing Error:", error);
    // Якщо файл залишився - пробуємо видалити
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