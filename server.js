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

// Ініціалізація Firebase
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
    try { serviceAccount = require('./serviceAccountKey.json'); } catch(e) { console.log("No service account file found"); }
}
if (serviceAccount) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Ініціалізація Хмари (R2) та AI
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
const generatePassword = (length = 12) => {
    const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$";
    let retVal = "";
    for (let i = 0, n = charset.length; i < length; ++i) {
        retVal += charset.charAt(Math.floor(Math.random() * n));
    }
    return retVal;
};

// Middleware для захисту API
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

// Головна та сторінки
app.get('/', (req, res) => res.send('✅ VDFY Server Ready'));
app.get('/r/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'recorder.html')));
app.get('/v/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'watch.html')));

// Отримання інфо для рекордера
app.get('/api/link-info/:id', async (req, res) => {
    try {
        const doc = await db.collection('shortLinks').doc(req.params.id).get();
        if (!doc.exists) return res.status(404).json({ error: "Not found" });
        res.json({ email: doc.data().email, formName: doc.data().formName });
    } catch (e) { res.status(500).json({ error: "Server error" }); }
});

// Створення короткого лінка (для розширення)
app.post('/api/shorten', async (req, res) => {
    try {
        const { type, email, formName, longUrl } = req.body;
        const shortId = generateShortId();
        const host = `https://${req.headers.host}`; 
        if (type === 'recorder') {
            await db.collection('shortLinks').doc(shortId).set({
                type: 'recorder', email, formName: formName || "Untitled Form", createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return res.json({ shortUrl: `${host}/r/${shortId}` });
        }
        res.status(400).send("Invalid type");
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ЗАВАНТАЖЕННЯ ТА ТРАНСКРИБАЦІЯ
app.post('/api/upload-with-ai', upload.single('file'), async (req, res) => {
    let tempPath = req.file.path;
    let compressedPath = tempPath + '_comp.mp4';
    try {
        const ownerEmail = req.body.folder ? req.body.folder.toLowerCase() : "public"; 
        const formName = req.body.subfolder ? sanitize(req.body.subfolder) : "General"; 
        const emailFolder = ownerEmail.replace(/[@.]/g, '_');

        // Стиснення
        await new Promise((res, rej) => {
            ffmpeg(tempPath).outputOptions(['-vcodec libx264', '-crf 28', '-preset veryfast', '-acodec aac']).save(compressedPath).on('end', res).on('error', rej);
        });

        // Whisper AI (Транскрибація)
        const transcription = await openai.audio.transcriptions.create({ 
            file: fs.createReadStream(compressedPath), model: "whisper-1",
            prompt: "Transcribe mixed languages. Привіт. Hello. English and Ukrainian combined. Дякую." 
        });

        const r2Key = `users/${emailFolder}/${formName}/rec_${Date.now()}.mp4`;
        
        // Завантаження в R2 (Відео та Текст)
        await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key, Body: fs.createReadStream(compressedPath), ContentType: "video/mp4" }));
        await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key.replace('.mp4', '.txt'), Body: transcription.text, ContentType: "text/plain" }));

        // Збереження в Firestore
        const shortId = generateShortId();
        await db.collection('shortLinks').doc(shortId).set({
            url: `${process.env.R2_PUBLIC_URL}/${r2Key}`,
            r2Key, type: 'video', email: ownerEmail, formName, transcription: transcription.text, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ publicUrl: `https://${req.headers.host}/v/${shortId}` });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { [tempPath, compressedPath].forEach(p => fs.existsSync(p) && fs.unlinkSync(p)); }
});

// AI АНАЛІЗ
app.post('/api/analyze-text', verifyToken, async (req, res) => {
    try {
        const textRes = await fetch(req.body.textUrl);
        const transcript = await textRes.text();
        const gpt = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: "Analyze candidate interview." }, { role: "user", content: transcript }]
        });
        res.json({ analysis: gpt.choices[0].message.content });
    } catch (e) { res.status(500).json({ error: "AI Error" }); }
});

// АДМІНКА: СТВОРЕННЯ КЛІЄНТА
app.post('/api/create-client', verifyToken, async (req, res) => {
    const ADMIN = "simonenkoyaroslav2008@gmail.com"; 
    if (req.user.email !== ADMIN) return res.status(403).send("Forbidden");
    const { email } = req.body;
    const password = generatePassword();
    await admin.auth().createUser({ email, password });
    res.json({ success: true, credentials: { email, password } });
});

// ОТРИМАННЯ ВІДЕО ДЛЯ КЛІЄНТА
app.get('/api/my-videos', verifyToken, async (req, res) => {
    const emailFolder = req.user.email.replace(/[@.]/g, '_');
    try {
        const data = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME, Prefix: `users/${emailFolder}/` }));
        const videos = (data.Contents || []).filter(i => i.Key.endsWith('.mp4')).map(i => ({
            key: i.Key, url: `${process.env.R2_PUBLIC_URL}/${i.Key}`, textUrl: `${process.env.R2_PUBLIC_URL}/${i.Key.replace('.mp4', '.txt')}`,
            uploadedAt: i.LastModified, formName: i.Key.split('/')[2] || "General"
        }));
        res.json({ videos });
    } catch (e) { res.json({ videos: [] }); }
});

app.delete('/api/delete-video', verifyToken, async (req, res) => {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: req.body.videoKey }));
    res.json({ success: true });
});

const serverInstance = app.listen(process.env.PORT || 3000, '0.0.0.0');
serverInstance.setTimeout(600000);