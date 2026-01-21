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

// Налаштування FFmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use((req, res, next) => {
    // Кажемо браузеру: "Ми не хочемо ізоляції, дозволь Google Login працювати скрізь"
    res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
    res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
    next();
});
// Базові налаштування
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// 🔥 ВАЖЛИВО: Статичні файли (index: false, щоб ми вручну керували головною сторінкою)
app.use(express.static('public', { index: false }));

// --- FIREBASE & CLOUD CONFIG ---
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

// --- HELPERS ---
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

// ==================================================================
// 🔥🔥🔥 ГОЛОВНІ МАРШРУТИ (РОУТИ) 🔥🔥🔥
// ==================================================================

app.get('/', (req, res) => res.send('✅ VDFY Server Ready'));

// 1. НОВА АДМІНКА (/admin) -> ДОЗВОЛЯЄМО POPUPS
app.get('/admin', (req, res) => {
    // 👇 ЦЕ ГОЛОВНЕ ВИПРАВЛЕННЯ: Дозволяємо вікна
    res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
    res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 2. СТАРИЙ ДЕШБОРД (/dashboard) -> ТЕЖ ДОЗВОЛЯЄМО
app.get('/dashboard', (req, res) => {
    res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
    res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// 3. РЕКОРДЕР (/r/:id) -> ТУТ ЗАХИСТ ЛИШАЄМО (Для FFmpeg)
app.get('/r/:id', (req, res) => {
    // Перебиваємо глобальні налаштування, бо FFmpeg потребує захисту
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.sendFile(path.join(__dirname, 'public', 'recorder.html'));
});

// 4. ПЕРЕГЛЯД ВІДЕО (/v/:id)
app.get('/v/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'watch.html')));

// 5. РЕДІРЕКТИ (/s/:id)
app.get('/s/:id', async (req, res) => {
    try {
        const doc = await db.collection('shortLinks').doc(req.params.id).get();
        if (!doc.exists) return res.status(404).send("Link not found");
        if (doc.data().type === 'video') return res.redirect(`/v/${req.params.id}`);
        if (doc.data().type === 'recorder') return res.redirect(`/r/${req.params.id}`);
        res.redirect(doc.data().url);
    } catch (e) { res.status(500).send("Server Error"); }
});

// ... (Решта API endpoints без змін) ...
// Отримати інфо про лінк
app.get('/api/link-info/:id', async (req, res) => {
    try {
        const doc = await db.collection('shortLinks').doc(req.params.id).get();
        if (!doc.exists) return res.status(404).json({ error: "Not found" });
        res.json({ email: doc.data().email, formName: doc.data().formName });
    } catch (e) { res.status(500).json({ error: "Server error" }); }
});

// Shorten
app.post('/api/shorten', async (req, res) => {
    try {
        const { type, email, formName, longUrl } = req.body;
        const shortId = generateShortId();
        const host = `https://${req.headers.host}`; 

        if (type === 'recorder') {
            await db.collection('shortLinks').doc(shortId).set({
                type: 'recorder', email: email, formName: formName || "General", createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return res.json({ shortUrl: `${host}/r/${shortId}` });
        } else {
            await db.collection('shortLinks').doc(shortId).set({ url: longUrl, type: 'general', createdAt: admin.firestore.FieldValue.serverTimestamp() });
            return res.json({ shortUrl: `${host}/s/${shortId}` });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload with AI
app.post('/api/upload-with-ai', upload.single('file'), async (req, res) => {
    req.setTimeout(600000); 
    let tempPath = null, compressedPath = null;
    try {
        if (!req.file) return res.status(400).json({ error: "No file" });
        const ownerEmail = req.body.folder ? req.body.folder.toLowerCase() : "public"; 
        
        let rawName = req.body.subfolder || "General";
        try { rawName = decodeURIComponent(rawName); } catch(e) {}
        const formName = sanitize(rawName);
        
        const emailFolder = ownerEmail.replace(/[@.]/g, '_');
        
        tempPath = req.file.path;
        compressedPath = tempPath + '_compressed.mp4';

        if (req.file.mimetype === 'video/mp4') {
             fs.copyFileSync(tempPath, compressedPath);
        } else {
            await new Promise((resolve, reject) => {
                ffmpeg(tempPath)
                    .outputOptions(['-vcodec libx264', '-crf 28', '-preset veryfast', '-acodec aac', '-b:a 128k'])
                    .save(compressedPath)
                    .on('end', resolve)
                    .on('error', reject);
            });
        }

        const transcription = await openai.audio.transcriptions.create({ 
            file: fs.createReadStream(compressedPath), model: "whisper-1", prompt: "Transcribe mixed languages." 
        });

        const r2Key = `users/${emailFolder}/${formName}/rec_${Date.now()}.mp4`;
        const longUrl = `${process.env.R2_PUBLIC_URL}/${r2Key}`;

        await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key, Body: fs.createReadStream(compressedPath), ContentType: "video/mp4" }));
        await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key.replace('.mp4', '.txt'), Body: transcription.text, ContentType: "text/plain; charset=utf-8" }));

        const shortId = generateShortId();
        await db.collection('shortLinks').doc(shortId).set({
            url: longUrl, r2Key: r2Key, type: 'video', email: ownerEmail, transcription: transcription.text, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        if (fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);

        res.json({ publicUrl: `https://${req.headers.host}/v/${shortId}`, transcription: transcription.text });
    } catch (e) { 
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        if (compressedPath && fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);
        res.status(500).json({ error: e.message }); 
    }
});

// My Videos
app.get('/api/my-videos', verifyToken, async (req, res) => {
    try {
        const email = req.user.email.toLowerCase();
        const data = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME, Prefix: `users/${email.replace(/[@.]/g, '_')}/` }));
        const videos = (data.Contents || []).filter(i => i.Key.endsWith('.mp4')).map(i => ({
            key: i.Key, url: `${process.env.R2_PUBLIC_URL}/${i.Key}`, textUrl: `${process.env.R2_PUBLIC_URL}/${i.Key.replace('.mp4', '.txt')}`,
            uploadedAt: i.LastModified, formName: i.Key.split('/').length > 3 ? decodeURIComponent(i.Key.split('/')[2]) : "General"
        }));
        res.json({ videos: videos.sort((a,b) => b.uploadedAt - a.uploadedAt) });
    } catch (e) { res.json({ videos: [] }); }
});

// Delete Video
app.delete('/api/delete-video', verifyToken, async (req, res) => {
    try {
        const videoKey = req.body.videoKey;
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: videoKey }));
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: videoKey.replace(/\.(mp4|webm)$/, '.txt') })).catch(()=>{});
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/analyze-text', verifyToken, async (req, res) => {
    try {
        const textRes = await fetch(req.body.textUrl);
        const gpt = await openai.chat.completions.create({
            model: "gpt-4o-mini", messages: [{ role: "system", content: "Summarize interview." }, { role: "user", content: await textRes.text() }]
        });
        res.json({ analysis: gpt.choices[0].message.content });
    } catch (error) { res.status(500).json({ error: "AI Error" }); }
});

app.post('/api/create-client', verifyToken, async (req, res) => {
    const ADMIN_EMAIL = "simonenkoyaroslav2008@gmail.com"; 
    if (req.user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return res.status(403).json({ error: "Access Denied" });
    try {
        const { email } = req.body;
        const password = Math.random().toString(36).substring(2, 12);
        await admin.auth().createUser({ email, password, emailVerified: true });
        res.json({ success: true, credentials: { email, password } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const serverInstance = app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log("🚀 Server running"));
serverInstance.setTimeout(600000);