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
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(express.static('public'));

const server = app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log("🚀 Server running"));
server.setTimeout(600000); 

// --- FIREBASE INIT ---
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
    try { serviceAccount = require('./serviceAccountKey.json'); } catch(e) {}
}
if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// --- R2 & OPENAI INIT ---
const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ dest: 'uploads/' });

// --- HELPERS ---
const sanitize = (str) => str.replace(/[^a-zA-Z0-9а-яА-ЯёЁіІїЇєЄ\-_ ]/g, '').trim();
const generateShortId = () => Math.random().toString(36).substring(2, 7); // 5 символів (напр. xk92m)

// --- MIDDLEWARE ---
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
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/recorder.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'recorder.html')));

// 🔥 1. GLOBAL REDIRECT (Обробляє короткі посилання /s/xxxxx)
app.get('/s/:id', async (req, res) => {
    try {
        const doc = await db.collection('shortLinks').doc(req.params.id).get();
        if (!doc.exists) return res.status(404).send("Link not found or expired.");
        
        // Якщо це посилання на відео (має secure access)
        if (doc.data().type === 'video') {
            // Перенаправляємо на сторінку перегляду (де є перевірка логіна)
            // Ми використовуємо старий механізм /v/id для перегляду, або прямий редірект
            // Для уніфікації: просто редіректимо на довгий URL
            return res.redirect(doc.data().url);
        }

        // Якщо це посилання на рекордер (Google Form)
        res.redirect(doc.data().url);
    } catch (e) {
        res.status(500).send("Server Error");
    }
});

// 🔥 2. API ДЛЯ СТВОРЕННЯ КОРОТКИХ ПОСИЛАНЬ (Викликається з розширення)
app.post('/api/shorten', async (req, res) => {
    try {
        const { longUrl, type } = req.body; // type: 'recorder' або 'video'
        if (!longUrl) return res.status(400).json({ error: "No URL provided" });

        const shortId = generateShortId();
        const serverUrl = `${req.protocol}://${req.get('host')}`;
        const shortUrl = `${serverUrl}/s/${shortId}`;

        await db.collection('shortLinks').doc(shortId).set({
            url: longUrl,
            type: type || 'general',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ shortUrl });
    } catch (e) {
        console.error("Shortener Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// 🔥 3. ВІДЕО-ДОСТУП (Secure Gatekeeper)
// Старий роут /v/:id залишаємо для сумісності або для secure view
app.get('/v/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'watch.html'));
});

// API для отримання реального відео (викликається з watch.html)
app.get('/api/get-secure-video/:id', verifyToken, async (req, res) => {
    try {
        // Тут ми шукаємо по ID. Це може бути ID з /s/ або старий /v/
        // Для спрощення: watch.html буде працювати з записами, створеними при upload
        const doc = await db.collection('shortLinks').doc(req.params.id).get();
        
        if (!doc.exists) return res.status(404).json({ error: "Not found" });
        
        const data = doc.data();
        const requester = req.user.email.toLowerCase();
        const owner = data.email ? data.email.toLowerCase() : "";

        if (requester !== owner) return res.status(403).json({ error: "Access Denied" });
        
        res.json({ url: data.url });
    } catch (e) { res.status(500).json({ error: "Server Error" }); }
});


// 4. UPLOAD VIDEO (Зберігає та скорочує)
app.post('/api/upload-with-ai', upload.single('file'), async (req, res) => {
    req.setTimeout(600000); 
    let tempPath = null, compressedPath = null;
    try {
        if (!req.file) return res.status(400).json({ error: "No file" });
        const ownerEmail = req.body.folder ? req.body.folder.toLowerCase() : "public"; 
        const formName = req.body.subfolder ? sanitize(req.body.subfolder) : "General"; 
        const emailFolder = ownerEmail.replace(/[@.]/g, '_');
        
        tempPath = req.file.path;
        compressedPath = tempPath + '_compressed.mp4';

        // Стиснення
        await new Promise((resolve, reject) => {
            ffmpeg(tempPath).outputOptions(['-vcodec libx264', '-crf 28', '-preset veryfast', '-acodec aac', '-b:a 128k'])
                .save(compressedPath).on('end', resolve).on('error', reject);
        });

        // Транскрибація
        const transcription = await openai.audio.transcriptions.create({ 
            file: fs.createReadStream(compressedPath), model: "whisper-1",
            prompt: "Video response. Languages: Ukrainian, Russian, English." 
        });

        // R2 Upload
        const r2Key = `users/${emailFolder}/${formName}/rec_${Date.now()}.mp4`;
        const longUrl = `${process.env.R2_PUBLIC_URL}/${r2Key}`;

        await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key, Body: fs.createReadStream(compressedPath), ContentType: "video/mp4" }));
        await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key.replace('.mp4', '.txt'), Body: transcription.text, ContentType: "text/plain; charset=utf-8" }));

        // 🔥 ГЕНЕРАЦІЯ КОРОТКОГО ПОСИЛАННЯ (на Secure View)
        const shortId = generateShortId();
        const serverUrl = `${req.protocol}://${req.get('host')}`;
        
        // Тут важливий момент: 
        // Якщо ми хочемо захист - посилання веде на /v/ID (watch.html).
        // Якщо хочемо пряме відео - посилання веде на R2.
        // Оскільки ми налаштували watch.html, ведемо туди.
        const secureViewUrl = `${serverUrl}/v/${shortId}`; 

        await db.collection('shortLinks').doc(shortId).set({
            url: longUrl, // Реальне посилання на файл
            r2Key: r2Key,
            type: 'video',
            email: ownerEmail,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        if (fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);

        // Повертаємо посилання на перегляд (воно виглядає як site.com/v/abcde)
        // Але ми можемо його ще скоротити через /s/, але /v/ вже достатньо коротке (site.com/v/5chars)
        res.json({ publicUrl: secureViewUrl, transcription: transcription.text });

    } catch (e) { 
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        if (compressedPath && fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);
        res.status(500).json({ error: e.message }); 
    }
});

app.get('/api/my-videos', verifyToken, async (req, res) => { /* код з V3.2 */ });
app.delete('/api/delete-video', verifyToken, async (req, res) => { /* код з V3.2 */ });
app.post('/api/analyze-text', verifyToken, async (req, res) => { /* код з V3.2 */ });

// LIST & DELETE & ANALYZE (Без змін)
app.get('/api/my-videos', verifyToken, async (req, res) => {
    const email = req.user.email ? req.user.email.toLowerCase() : null;
    if (!email) return res.json({ videos: [] });
    const emailFolder = email.replace(/[@.]/g, '_');
    
    try {
        const data = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME, Prefix: `users/${emailFolder}/` }));
        const videos = (data.Contents || []).filter(i => i.Key.endsWith('.mp4') || i.Key.endsWith('.webm')).map(i => {
            return {
                key: i.Key,
                url: `${process.env.R2_PUBLIC_URL}/${i.Key}`,
                textUrl: `${process.env.R2_PUBLIC_URL}/${i.Key.replace(/\.(mp4|webm)$/, '.txt')}`,
                uploadedAt: i.LastModified,
                formName: i.Key.split('/').length > 3 ? decodeURIComponent(i.Key.split('/')[2]) : "General"
            };
        });
        res.json({ videos: videos.sort((a,b) => b.uploadedAt - a.uploadedAt) });
    } catch (e) { res.json({ videos: [] }); }
});

app.delete('/api/delete-video', verifyToken, async (req, res) => {
    try {
        const email = req.user.email.toLowerCase();
        const emailFolder = email.replace(/[@.]/g, '_');
        const videoKey = req.body.videoKey;

        if (!videoKey.startsWith(`users/${emailFolder}/`)) return res.status(403).json({ error: "Access Denied" });
        
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: videoKey }));
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: videoKey.replace(/\.(mp4|webm)$/, '.txt') })).catch(()=>{});

        const snapshot = await db.collection('shortLinks').where('r2Key', '==', videoKey).get();
        if (!snapshot.empty) {
            const batch = db.batch();
            snapshot.docs.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/analyze-text', verifyToken, async (req, res) => {
    try {
        const textRes = await fetch(req.body.textUrl);
        const originalText = await textRes.text();
        const gpt = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: "Summarize this." }, { role: "user", content: originalText }]
        });
        res.json({ analysis: gpt.choices[0].message.content });
    } catch (error) { res.status(500).json({ error: "AI Error" }); }
});