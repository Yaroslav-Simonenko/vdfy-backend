require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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
    try { serviceAccount = require('./serviceAccountKey.json'); } catch(e) {}
}

if (serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

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

// --- MIDDLEWARE AUTH (Тільки для Адмінки) ---
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
        req.user = { uid: userData.sub, email: userData.email };
        return next();
    } catch (error) {
        return res.status(403).json({ error: 'Forbidden' });
    }
};

// ================= ROUTES =================

app.get('/', (req, res) => res.send('✅ VDFY Backend Ready'));

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// 🔓 1. ЗАВАНТАЖЕННЯ (SAAS: Публічний доступ для запису)
// Клієнт відправляє відео, вказуючи UID автора форми в полі "folder"
app.post('/api/upload-with-ai', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file" });

        // folder тут - це UID власника форми
        const ownerUid = req.body.folder; 
        if (!ownerUid) return res.status(400).json({ error: "Missing Form Owner UID" });

        const newPath = req.file.path + '.webm';
        fs.renameSync(req.file.path, newPath);

        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(newPath),
            model: "whisper-1",
        });

        const fileStream = fs.createReadStream(newPath);
        const fileName = `rec_${Date.now()}.webm`;
        
        // Зберігаємо в папку КОНКРЕТНОГО ЮЗЕРА (Автора форми)
        const r2Key = `users/${ownerUid}/${fileName}`;

        await s3.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: r2Key,
            Body: fileStream,
            ContentType: "video/webm",
        }));

        const textKey = r2Key.replace('.webm', '.txt');
        await s3.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: textKey,
            Body: transcription.text,
            ContentType: "text/plain; charset=utf-8"
        }));

        fs.unlinkSync(newPath);

        res.json({ 
            success: true, 
            publicUrl: `${process.env.R2_PUBLIC_URL}/${r2Key}`,
            transcription: transcription.text
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 🔒 2. СПИСОК ВІДЕО (Тільки мої)
app.get('/api/my-videos', verifyToken, async (req, res) => {
    try {
        // Показуємо файли тільки з папки поточного авторизованого юзера
        const myPrefix = `users/${req.user.uid}/`;

        const command = new ListObjectsV2Command({
            Bucket: process.env.R2_BUCKET_NAME,
            Prefix: myPrefix
        });

        const data = await s3.send(command);
        if (!data.Contents) return res.json({ videos: [] });

        const videoFiles = data.Contents.filter(item => item.Key.endsWith('.webm'));
        const allKeys = new Set(data.Contents.map(item => item.Key));

        const videos = videoFiles.map(item => {
            const textKey = item.Key.replace('.webm', '.txt');
            const hasText = allKeys.has(textKey);

            return {
                key: item.Key,
                url: `${process.env.R2_PUBLIC_URL}/${item.Key}`,
                textUrl: hasText ? `${process.env.R2_PUBLIC_URL}/${textKey}` : null,
                uploadedAt: item.LastModified
            };
        });

        videos.sort((a, b) => b.uploadedAt - a.uploadedAt);
        res.json({ videos });
    } catch (error) {
        res.status(500).json({ error: "Failed to list videos" });
    }
});

// AI АНАЛІЗ
app.post('/api/analyze-text', verifyToken, async (req, res) => {
    try {
        const { textUrl } = req.body;
        const textRes = await fetch(textUrl);
        const originalText = await textRes.text();

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Summarize briefly." },
                { role: "user", content: originalText }
            ],
        });

        res.json({ analysis: completion.choices[0].message.content });
    } catch (error) {
        res.status(500).json({ error: "AI Analysis failed" });
    }
});

// 🔒 3. ВИДАЛЕННЯ (Безпечне)
app.delete('/api/delete-video', verifyToken, async (req, res) => {
    try {
        const { videoKey } = req.body;
        // Перевірка безпеки: чи належить файл цьому юзеру?
        if (!videoKey.startsWith(`users/${req.user.uid}/`)) {
            return res.status(403).json({ error: "Access denied to this file" });
        }

        const textKey = videoKey.replace('.webm', '.txt');

        await s3.send(new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: videoKey
        }));

        await s3.send(new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: textKey
        })).catch(() => {});

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is listening on 0.0.0.0:${PORT}`);
});