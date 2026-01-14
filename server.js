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

// Firebase Service Account
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

// R2 Storage
const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ dest: 'uploads/' });

// --- Helper: Очистка Email для назви папки (serge@gmail.com -> serge_gmail_com) ---
const sanitizeEmail = (email) => email.replace(/[@.]/g, '_');

// --- Middleware Auth ---
const verifyToken = async (req, res, next) => {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = decoded; // Тут є decoded.email
        next();
    } catch (e) {
        try {
            const r = await fetch(`https://www.googleapis.com/oauth2/v3/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
            req.user = await r.json(); // Тут є req.user.email
            next();
        } catch { return res.status(403).json({ error: 'Forbidden' }); }
    }
};

// ================= ROUTES =================

app.get('/', (req, res) => res.send('✅ VDFY Email-Based Server Ready'));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// 🔓 1. ЗАВАНТАЖЕННЯ (Клієнт шле на Email автора)
app.post('/api/upload-with-ai', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file" });
        
        // Отримуємо EMAIL автора форми (замість UID)
        const ownerEmail = req.body.folder; 
        if (!ownerEmail || !ownerEmail.includes('@')) {
            // Fallback: якщо email не прийшов, кладемо в папку public
            console.log("No valid email provided, using public folder");
        }

        const folderName = ownerEmail ? sanitizeEmail(ownerEmail) : "public_uploads";
        
        const newPath = req.file.path + '.webm';
        fs.renameSync(req.file.path, newPath);

        const transcription = await openai.audio.transcriptions.create({ file: fs.createReadStream(newPath), model: "whisper-1" });
        
        // Зберігаємо в папку: users/serge_gmail_com/...
        const r2Key = `users/${folderName}/rec_${Date.now()}.webm`;

        await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key, Body: fs.createReadStream(newPath), ContentType: "video/webm" }));
        await s3.send(new PutObjectCommand({ 
            Bucket: process.env.R2_BUCKET_NAME, 
            Key: r2Key.replace('.webm', '.txt'), 
            Body: transcription.text, 
            ContentType: "text/plain; charset=utf-8" 
        }));

        fs.unlinkSync(newPath);
        res.json({ publicUrl: `${process.env.R2_PUBLIC_URL}/${r2Key}`, transcription: transcription.text });
    } catch (e) { 
        console.error(e);
        res.status(500).json({ error: e.message }); 
    }
});

// 🔒 2. МОЇ ВІДЕО (Шукаємо по Email юзера)
app.get('/api/my-videos', verifyToken, async (req, res) => {
    const email = req.user.email;
    if (!email) return res.json({ videos: [] });

    const folderName = sanitizeEmail(email);
    console.log(`Fetching videos for folder: users/${folderName}/`);

    const data = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME, Prefix: `users/${folderName}/` }));
    
    const videos = (data.Contents || []).filter(i => i.Key.endsWith('.webm')).map(i => ({
        key: i.Key,
        url: `${process.env.R2_PUBLIC_URL}/${i.Key}`,
        textUrl: `${process.env.R2_PUBLIC_URL}/${i.Key.replace('.webm', '.txt')}`,
        uploadedAt: i.LastModified
    }));
    res.json({ videos: videos.sort((a,b) => b.uploadedAt - a.uploadedAt) });
});

// 🔒 3. ВИДАЛЕННЯ
app.delete('/api/delete-video', verifyToken, async (req, res) => {
    const folderName = sanitizeEmail(req.user.email);
    // Дозволяємо видаляти тільки зі своєї папки
    if (!req.body.videoKey.startsWith(`users/${folderName}/`)) return res.status(403).json({ error: "Access Denied" });
    
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: req.body.videoKey }));
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: req.body.videoKey.replace('.webm', '.txt') })).catch(()=>{});
    res.json({ success: true });
});

// 🔒 4. AI
app.post('/api/analyze-text', verifyToken, async (req, res) => {
    const textRes = await fetch(req.body.textUrl);
    const text = await textRes.text();
    const gpt = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: "Summarize." }, { role: "user", content: text }]
    });
    res.json({ analysis: gpt.choices[0].message.content });
});

app.listen(3000, '0.0.0.0', () => console.log("🚀 Server running on 3000"));