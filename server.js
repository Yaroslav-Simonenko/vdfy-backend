require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);
const app = express();

// 👇👇👇 ТВОЯ ПОШТА ГОЛОВНОГО АДМІНА 👇👇👇
const ADMIN_EMAIL = "simonenkoyaroslav2008@gmail.com"; 

app.use((req, res, next) => {
    res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
    res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
    res.setHeader("Referrer-Policy", "no-referrer-when-downgrade");
    next();
});

app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(express.static('public', { index: false }));

let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
    try { serviceAccount = require('./serviceAccountKey.json'); } catch(e) {}
}
if (serviceAccount) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ dest: 'uploads/' });

const sanitize = (str) => str.replace(/[^a-zA-Z0-9а-яА-ЯёЁіІїЇєЄ\-_ ]/g, '').trim();
const generateShortId = () => Math.random().toString(36).substring(2, 7);

const verifyToken = async (req, res, next) => {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = decoded;
        next();
    } catch (e) { return res.status(403).json({ error: 'Forbidden' }); }
};

// --- ROUTES ---
app.get('/', (req, res) => res.send('✅ VDFY Server Ready'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/r/:id', (req, res) => {
    res.header("Cross-Origin-Embedder-Policy", "require-corp");
    res.header("Cross-Origin-Opener-Policy", "same-origin");
    res.sendFile(path.join(__dirname, 'public', 'recorder.html'));
});
app.get('/v/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'watch.html')));
app.get('/s/:id', async (req, res) => {
    try {
        const doc = await db.collection('shortLinks').doc(req.params.id).get();
        if (!doc.exists) return res.status(404).send("Link not found");
        if (doc.data().type === 'video') return res.redirect(`/v/${req.params.id}`);
        if (doc.data().type === 'recorder') return res.redirect(`/r/${req.params.id}`);
        res.redirect(doc.data().url);
    } catch (e) { res.status(500).send("Server Error"); }
});

// --- API ---

// 1. ОТРИМАННЯ ВІДЕО (ОНОВЛЕНО ДЛЯ АДМІНА)
app.get('/api/my-videos', verifyToken, async (req, res) => {
    try {
        const email = req.user.email.toLowerCase();
        let prefix = `users/${email.replace(/[@.]/g, '_')}/`;
        
        // 🔥 Якщо це Адмін - показуємо ВСІ папки users/
        if (email === ADMIN_EMAIL.toLowerCase()) {
            prefix = `users/`;
        }

        const data = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME, Prefix: prefix }));
        
        const videos = (data.Contents || []).filter(i => i.Key.endsWith('.mp4')).map(i => {
            const parts = i.Key.split('/');
            // Структура: users / email_folder / form_name / video.mp4
            // parts[0]=users, parts[1]=owner, parts[2]=formName
            return {
                key: i.Key,
                url: `${process.env.R2_PUBLIC_URL}/${i.Key}`, 
                uploadedAt: i.LastModified,
                owner: parts.length > 1 ? parts[1].replace(/_/g, '.') : "Unknown", // Відновлюємо емейл з назви папки
                formName: parts.length > 2 ? decodeURIComponent(parts[2]) : "General"
            };
        });
        
        res.json({ videos: videos.sort((a,b) => b.uploadedAt - a.uploadedAt) });
    } catch (e) { res.json({ videos: [] }); }
});

// 2. СТВОРЕННЯ КЛІЄНТА (АВТО-ПАРОЛЬ)
app.post('/api/create-client', verifyToken, async (req, res) => {
    // Тільки адмін може створювати
    if (req.user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
        return res.status(403).json({ error: "Access Denied" });
    }

    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: "Email required" });
        
        // 🔥 Генеруємо випадковий пароль (8 символів)
        const password = Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-4);
        
        const userRecord = await admin.auth().createUser({
            email: email,
            password: password,
            emailVerified: true
        });
        
        res.json({ success: true, email: userRecord.email, password: password });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ... Решта API без змін ...
app.get('/api/link-info/:id', async (req, res) => { /* ... старий код ... */ });
app.post('/api/shorten', async (req, res) => { /* ... старий код ... */ });
app.post('/api/upload-with-ai', upload.single('file'), async (req, res) => { 
    // ... Встав сюди свій великий код завантаження upload-with-ai ...
    res.json({ success: true }); 
});
app.delete('/api/delete-video', verifyToken, async (req, res) => {
    try {
        const videoKey = req.body.videoKey;
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: videoKey }));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/analyze-text', verifyToken, async (req, res) => { /* ... старий код ... */ });


const serverInstance = app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log("🚀 Server running"));
serverInstance.setTimeout(600000);